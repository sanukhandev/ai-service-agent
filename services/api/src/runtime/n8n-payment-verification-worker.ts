/**
 * Bounded polling of the existing authenticated 2Checkout GET path.
 * Never posts a new order, trusts a redirect, or interprets n8n's HTTP 200 as
 * payment evidence. PaymentOperations.verify performs identity+amount checks.
 */
import { PersistenceDatabase } from "../database/pool.js";
import { workerTicketScope } from "../repositories/types.js";
import { PaymentOperations } from "./payment-operations.js";
import { paymentEnabled } from "./payment-evidence.js";

export class N8nPaymentVerificationWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private busy=false;
  private stopped=false;
  private readonly payments:PaymentOperations;
  constructor(
    private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void,
  ){this.payments=new PaymentOperations(db);}
  start():void {
    if(!paymentEnabled()){
      this.log({enabled:false},"Automatic 2Checkout verification disabled");
      return;
    }
    this.timer=setInterval(()=>{void this.tick();},15000);
    this.timer.unref();void this.tick();
  }
  stop():void {this.stopped=true;if(this.timer)clearInterval(this.timer);}
  private async agentId():Promise<string|null>{
    const r=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'");
    return r.rows[0]?.id??null;
  }
  private async eligible(agentId:string):Promise<{ticketId:string;paymentId:string}|null>{
    return this.db.withAgent(agentId,async client=>{
      const r=await client.query<{ticket_id:string;id:string}>(
        `SELECT p.ticket_id,p.id FROM ticket_payment_attempts p
         JOIN tickets t ON t.agent_id=p.agent_id AND t.id=p.ticket_id
         WHERE p.agent_id=$1 AND p.order_reference IS NOT NULL
           AND p.state IN ('checkout_available','order_created_checkout_unavailable',
             'payment_pending','unknown_outcome','verifying','verified_test_payment')
           AND (p.state<>'verifying' OR p.verification_started_at<now()-interval '2 minutes')
           AND p.verification_attempts<60
           AND p.next_verification_at<=now()
           AND p.created_at>now()-interval '24 hours'
           AND t.status<>'closed'
         ORDER BY p.next_verification_at,p.created_at,p.id LIMIT 1`,[agentId]);
      return r.rows[0]?{ticketId:r.rows[0].ticket_id,paymentId:r.rows[0].id}:null;
    });
  }
  private async tick(){
    if(this.busy||this.stopped||!paymentEnabled())return;
    this.busy=true;
    try{
      const agent=await this.agentId();if(!agent)return;
      const item=await this.eligible(agent);if(!item)return;
      await this.payments.verify(
        workerTicketScope(agent,item.ticketId),item.ticketId,item.paymentId);
      this.log({paymentId:item.paymentId},"Read-only 2Checkout status checked");
    }catch(e) {
      this.log({errorCode:(e as Error).name},"Automatic 2Checkout GET check postponed");
    }finally{this.busy=false;}
  }
}
