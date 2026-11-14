import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import type { PendingFunctionState, PendingFunctionStore } from "../gemini/adapter.js";

/** Durable authenticated encryption for opaque tool continuation. Neither the
 * model nor HTTP caller selects the trusted agent/session scope. */
export class PgGeminiPendingStore implements PendingFunctionStore {
  private readonly key: Buffer;
  constructor(private readonly db: PersistenceDatabase,
    private readonly agentId: string,private readonly sessionId: string,
    hexEncryptionKey: string) {
    requireUuid(agentId,"agentId");requireUuid(sessionId,"sessionId");
    if(!/^[0-9a-fA-F]{64}$/.test(hexEncryptionKey))
      throw new PersistenceError("NOT_CONFIGURED","GEMINI_STATE_ENCRYPTION_KEY must be a 32-byte hex secret");
    this.key=Buffer.from(hexEncryptionKey,"hex");
  }
  async save(state: PendingFunctionState): Promise<string> {
    if(state.agentId!==this.agentId || state.sessionId!==this.sessionId)
      throw new PersistenceError("INVALID_INPUT","Tool state scope mismatch");
    const id=randomUUID();
    const nonce=randomBytes(12);
    const cipher=createCipheriv("aes-256-gcm",this.key,nonce);
    cipher.setAAD(Buffer.from(this.agentId+":"+this.sessionId+":"+id));
    const serialized=JSON.stringify(state);
    if(Buffer.byteLength(serialized,"utf8")>262144)
      throw new PersistenceError("INVALID_INPUT","Tool state too large");
    const ciphertext=Buffer.concat([cipher.update(serialized,"utf8"),cipher.final()]);
    const tag=cipher.getAuthTag();
    await this.db.withAgent(this.agentId,async client=>{
      const saved=await client.query(
        `INSERT INTO gemini_pending_function_states(agent_id,session_id,id,nonce,encrypted_state,auth_tag,expires_at)
         SELECT $1,$2,$3,$4,$5,$6,LEAST(expires_at,clock_timestamp()+interval '10 minutes')
         FROM ai_conversation_sessions
         WHERE agent_id=$1 AND id=$2 AND status='active'
           AND expires_at>clock_timestamp() RETURNING id`,
        [this.agentId,this.sessionId,id,nonce,ciphertext,tag],
      );
      if(saved.rowCount!==1)throw new PersistenceError("CONFLICT","AI session expired");
    });
    return id;
  }
  async take(reference: string): Promise<PendingFunctionState | null> {
    requireUuid(reference,"pendingToolStateRef");
    return this.db.withAgent(this.agentId,async client=>{
      const result=await client.query<{nonce:Buffer;encrypted_state:Buffer;auth_tag:Buffer}>(
        `DELETE FROM gemini_pending_function_states
         WHERE agent_id=$1 AND session_id=$2 AND id=$3
           AND expires_at>clock_timestamp()
         RETURNING nonce,encrypted_state,auth_tag`,
        [this.agentId,this.sessionId,reference],
      );
      const row=result.rows[0];if(!row)return null;
      try{
        const decipher=createDecipheriv("aes-256-gcm",this.key,row.nonce);
        decipher.setAAD(Buffer.from(this.agentId+":"+this.sessionId+":"+reference));
        decipher.setAuthTag(row.auth_tag);
        const plaintext=Buffer.concat([decipher.update(row.encrypted_state),decipher.final()]);
        const decoded=JSON.parse(plaintext.toString("utf8")) as PendingFunctionState;
        if(decoded.agentId!==this.agentId||decoded.sessionId!==this.sessionId)
          throw new Error("Scope mismatch");
        return decoded;
      } catch{throw new PersistenceError("CONFLICT","Pending tool continuation invalid");}
    });
  }
}
