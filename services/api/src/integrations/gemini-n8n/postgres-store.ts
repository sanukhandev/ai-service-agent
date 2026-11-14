/** Durable adapter to the existing migrations 001-008. No new workflow state machine. */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PersistenceDatabase, PersistenceError, requireUuid } from '../../database/pool.js';
import { appendEventTx } from '../../repositories/events.js';
import type { Claim, DispatchScope, OperationStore, Outcome } from './adapter.js';

interface DbClaimRow {
  id: string; agent_id: string; ticket_id: string; outbox_id: string;
  operation_key: 'ancfz_salesforce_lead' | 'ancfz_render_quote';
  payload_digest: string; event_type: string; payload: Record<string, unknown>;
  idempotency_key: string;
}

/** The ticket is a server-issued scope obtained by the worker, not Gemini arguments. */
export class PostgresOperationStore implements OperationStore {
  constructor(private readonly db: PersistenceDatabase) {}

  async claim(scope: DispatchScope): Promise<Claim | null> {
    requireUuid(scope.agentId,'agentId');
    requireUuid(scope.ticketId,'ticketId');
    requireUuid(scope.operationId,'operationId');
    return this.db.withAgent(scope.agentId, async client => {
      const selected = await client.query<DbClaimRow>(`
        SELECT op.id,op.agent_id,op.ticket_id,op.outbox_id,op.operation_key,
          op.payload_digest,e.event_type,e.payload,e.idempotency_key
        FROM ticket_operations op
        JOIN event_outbox e ON e.agent_id=op.agent_id AND e.ticket_id=op.ticket_id AND e.id=op.outbox_id
        JOIN tickets t ON t.agent_id=op.agent_id AND t.id=op.ticket_id
        JOIN agents a ON a.id=op.agent_id AND a.agent_key='ancfz' AND a.status='active'
        WHERE op.agent_id=$1 AND op.ticket_id=$2 AND op.id=$3
          AND op.state='queued' AND e.status IN ('pending','retryable_failed') AND e.attempts<3
          AND op.consented_at IS NOT NULL AND e.idempotency_key IS NOT NULL
          AND e.event_type=op.operation_key AND op.operation_key IN ('ancfz_salesforce_lead','ancfz_render_quote')
        FOR UPDATE OF op,e SKIP LOCKED`,
      [scope.agentId, scope.ticketId, scope.operationId]);
      const row=selected.rows[0];
      if (!row) return null;
      await assertPreflight(client,row);
      const updated = await client.query<{id:string}>(`
        UPDATE event_outbox SET status='leased',attempts=attempts+1,
          lease_until=now()+interval '120 seconds'
        WHERE agent_id=$1 AND ticket_id=$2 AND id=$3
          AND status IN ('pending','retryable_failed') AND attempts<3 RETURNING id`,
      [scope.agentId, scope.ticketId,row.outbox_id]);
      if (!updated.rows[0]) throw new PersistenceError('CONFLICT','Outbox was already claimed');
      await client.query(`UPDATE ticket_operations SET state='running',updated_at=now()
        WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND state='queued'`,
      [scope.agentId,scope.ticketId,scope.operationId]);
      await appendEventTx(client,scope.agentId,scope.ticketId,'operation.running',{
        operationId: row.id,operationType:row.operation_key,outboxId:row.outbox_id,
      });
      return {
        agentId:row.agent_id,ticketId:row.ticket_id,operationId:row.id,outboxId:row.outbox_id,
        key:row.operation_key,idempotencyKey:row.idempotency_key,payload:row.payload,
      };
    });
  }

  async finish(claim: Claim, outcome: Outcome): Promise<boolean> {
    return this.db.withAgent(requireUuid(claim.agentId,'agentId'),async client => {
      const current = await client.query<{state:string;status:string;attempts:number}>(`
        SELECT op.state,e.status,e.attempts FROM ticket_operations op
        JOIN event_outbox e ON e.agent_id=op.agent_id AND e.ticket_id=op.ticket_id AND e.id=op.outbox_id
        WHERE op.agent_id=$1 AND op.ticket_id=$2 AND op.id=$3 AND op.outbox_id=$4
        FOR UPDATE OF op,e`,
      [claim.agentId,claim.ticketId,claim.operationId,claim.outboxId]);
      if(current.rows[0]?.state!=='running' || current.rows[0]?.status!=='leased') return false;
      if(outcome.state==='verified_completed' && claim.key==='ancfz_render_quote') {
        if(!outcome.pdf) throw new PersistenceError('CONFLICT','Verified PDF bytes missing');
        const q=await client.query<{id:string}>(`
          SELECT id FROM ticket_quotations WHERE agent_id=$1 AND ticket_id=$2 AND operation_id=$3
          AND document_number=$4`,[claim.agentId,claim.ticketId,claim.operationId,outcome.providerReference]);
        if(!q.rows[0]) throw new PersistenceError('CONFLICT','Quotation scope mismatch');
        await client.query(`INSERT INTO ticket_quotation_pdfs(agent_id,ticket_id,quotation_id,bytes,sha256)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT (agent_id,ticket_id,quotation_id) DO NOTHING`,
        [claim.agentId,claim.ticketId,q.rows[0].id,outcome.pdf.bytes,outcome.pdf.sha256]);
      }
      // The pre-migration operation states allow 'queued' for a safe pre-dispatch retry,
      // while event_outbox owns the distinct retryable_failed status.
      const retryable=outcome.state==='retryable_failure' && current.rows[0].attempts < 3;
      const next=retryable?'queued':outcome.state==='retryable_failure'?'terminal_failed':outcome.state;
      const status=retryable?'retryable_failed':outcome.state==='verified_completed'?'completed':'dead';
      await client.query(`UPDATE ticket_operations SET state=$5,provider_status=$6,provider_reference=$7,
        updated_at=now() WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND outbox_id=$4`,
      [claim.agentId,claim.ticketId,claim.operationId,claim.outboxId,next,outcome.reason,outcome.providerReference]);
      await client.query(`UPDATE event_outbox SET status=$4,lease_until=NULL WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
      [claim.agentId,claim.ticketId,claim.outboxId,status]);
      await appendEventTx(client,claim.agentId,claim.ticketId,
        outcome.state==='verified_completed'?'operation.completed':'operation.failed',{
          operationId:claim.operationId,operationType:claim.key,outboxId:claim.outboxId,
          providerReference:outcome.providerReference,verified:outcome.state==='verified_completed',
          reason:outcome.reason, ...(outcome.pdf?{sha256:outcome.pdf.sha256}:{}),
        });
      return true;
    });
  }

  async quarantine(agentId: string): Promise<number> {
    return this.db.withAgent(requireUuid(agentId,'agentId'),async client=>{
      const expired = await client.query<{id:string;ticket_id:string;outbox_id:string;operation_key:string}>(`
        SELECT op.id,op.ticket_id,op.outbox_id,op.operation_key FROM ticket_operations op
        JOIN event_outbox e ON e.agent_id=op.agent_id AND e.ticket_id=op.ticket_id AND e.id=op.outbox_id
        WHERE op.agent_id=$1 AND op.state='running' AND e.status='leased'
          AND e.lease_until<now() AND op.operation_key IN ('ancfz_salesforce_lead','ancfz_render_quote')
        LIMIT 50 FOR UPDATE OF op,e SKIP LOCKED`,[agentId]);
      for(const row of expired.rows){
        await client.query(`UPDATE ticket_operations SET state='unknown_outcome',provider_status='lease_expired',updated_at=now()
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,[agentId,row.ticket_id,row.id]);
        await client.query(`UPDATE event_outbox SET status='dead',lease_until=NULL
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,[agentId,row.ticket_id,row.outbox_id]);
        await appendEventTx(client,agentId,row.ticket_id,'operation.failed',{
          operationId:row.id,operationType:row.operation_key,
          reason:'Provider outcome uncertain after worker restart; manual reconciliation required',
        });
      }
      return expired.rows.length;
    });
  }
}

async function assertPreflight(client: PoolClient,row:DbClaimRow): Promise<void> {
  const p=row.payload;
  if(!p || p.ticketId!==row.ticket_id || p.agentKey!=='ancfz')
    throw new PersistenceError('CONFLICT','Outbox payload lost authorized scope');
  if(row.operation_key==='ancfz_salesforce_lead'){
    if(p.consent!==true)throw new PersistenceError('CONFLICT','Lead consent absent');
    const lead={ name:p.name,company:p.company,phone:p.phone,email:p.email,description:p.description };
    const digest=createHash('sha256').update(JSON.stringify(lead)).digest('hex');
    if(digest!==row.payload_digest)throw new PersistenceError('CONFLICT','Lead payload changed since approval');
    const eligible=await client.query(`SELECT 1 FROM ticket_intents ti
      JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
      JOIN tickets t ON t.agent_id=ti.agent_id AND t.id=ti.ticket_id
      WHERE ti.agent_id=$1 AND ti.ticket_id=$2 AND ti.status='active'
        AND i.catalog_version_id=t.intent_catalog_version_id
        AND 'create_lead'=ANY(i.allowed_actions) LIMIT 1`,[row.agent_id,row.ticket_id]);
    if(!eligible.rows.length)throw new PersistenceError('CONFLICT','Lead intent is not authorized');
  } else {
    const q=await client.query<{document_number:string;amount:string;currency:string;offering_label:string}>(`
      SELECT q.document_number,q.amount::text AS amount,q.currency,q.offering_label
      FROM ticket_quotations q
      JOIN ticket_operations lead ON lead.agent_id=q.agent_id AND lead.ticket_id=q.ticket_id
        AND lead.operation_key='ancfz_salesforce_lead' AND lead.state='verified_completed'
        AND lead.provider_reference=q.salesforce_lead_id
      WHERE q.agent_id=$1 AND q.ticket_id=$2 AND q.operation_id=$3`,
    [row.agent_id,row.ticket_id,row.id]);
    const quote=q.rows[0];
    const lines=Array.isArray(p.lines)?p.lines:[];
    const first=lines[0] as Record<string,unknown>|undefined;
    if(!quote || p.documentType!=='quotation' || p.documentNumber!==quote.document_number ||
      p.currency!==quote.currency.trim() || lines.length!==1 || first?.label!==quote.offering_label ||
      first?.amount!==Number(quote.amount) || p.total!==Number(quote.amount))
      throw new PersistenceError('CONFLICT','Quotation does not match approved price and verified lead');
  }
}
