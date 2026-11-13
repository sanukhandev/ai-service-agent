import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository, GuestSessionRepository, TicketRepository, TicketMessageRepository, TicketEventRepository } from "../repositories/index.js";
import { hashGuestToken, workerTicketScope, type TicketRecord, type TicketScope, type MessageRecord, type EventRecord, type SourceReference } from "../repositories/types.js";
import { TurnQueue } from "./turn-queue.js";
import { FoundryClient } from "../foundry/client.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { LeadOperations, leadDispatchEnabled } from "./lead-operations.js";
import { QuotationOperations } from "./quotation-operations.js";

function cleanSourceTitle(rawTitle?: string, sourceId?: string): string {
  const combined = `${rawTitle ?? ""} ${sourceId ?? ""}`.toLowerCase();
  if (combined.includes("license") || combined.includes("cost") || combined.includes("fee")) return "ANCFZ License Costs & Fees (2026)";
  if (combined.includes("package") || combined.includes("offer") || combined.includes("price")) return "ANCFZ Setup Packages & Inclusions";
  if (combined.includes("rule") || combined.includes("regulation") || combined.includes("law")) return "ANCFZ Rules & Regulations";
  if (combined.includes("type") || combined.includes("fze") || combined.includes("fzc")) return "ANCFZ Types of Companies";
  if (combined.includes("activit") || combined.includes("categor")) return "ANCFZ Business Activity Categories";
  if (combined.includes("partner")) return "ANCFZ Strategic Partners";
  if (combined.includes("faq")) return "ANCFZ Official FAQs";
  if (combined.includes("contact")) return "ANCFZ Contact & Directory";
  if (rawTitle && !rawTitle.startsWith("http")) return rawTitle;
  return "ANCFZ Official Knowledge Reference";
}

function ticketView(ticket:TicketRecord,agentKey:string) {
  return {id:ticket.id,number:String(ticket.ticketNumber),agentKey,
    subject:ticket.subject,status:ticket.status,createdAt:ticket.createdAt};
}
function messageView(message:MessageRecord) {
  return {id:message.id,role:message.role,text:message.text,
    createdAt:message.createdAt,
    sourceReferences:(message.sourceReferences ?? []).map(ref => ({
      ...ref,
      title: cleanSourceTitle(ref.title ?? undefined, ref.sourceId),
      uri: `/api/v1/tickets/${message.ticketId}/sources/${encodeURIComponent(ref.sourceId)}/download`,
    }))};
}
function cookieToken(request:FastifyRequest):string|null {
  const raw=request.headers.cookie;
  if(!raw) return null;
  const matches=raw.split(";").map(s=>s.trim()).filter(s=>s.startsWith("sa_guest="));
  if(matches.length!==1) return null;
  const token=matches[0]?.slice("sa_guest=".length) ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function rejectCrossSite(request:FastifyRequest):void {
  const origin=request.headers.origin;
  const host=request.headers.host;
  if(origin && (!host || new URL(origin).host.toLowerCase()!==host.toLowerCase())) {
    throw new PersistenceError("INVALID_INPUT","Cross-site request denied");
  }
  if(request.headers["sec-fetch-site"] === "cross-site") {
    throw new PersistenceError("INVALID_INPUT","Cross-site request denied");
  }
}
function idParam(request:FastifyRequest):string {
  const params=request.params as Record<string,unknown>;
  const id=params["ticketId"];
  if(typeof id!=="string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) {
    throw new PersistenceError("NOT_FOUND","Ticket not found");
  }
  return id;
}
async function scopeFromCookie(db:PersistenceDatabase,request:FastifyRequest):Promise<TicketScope> {
  const token=cookieToken(request);
  if(!token) throw new PersistenceError("NOT_FOUND","Ticket not found");
  const result=await db.pool.query<{ agent_id:string|null }>(
    "SELECT public.resolve_guest_agent($1) AS agent_id",[hashGuestToken(token)]);
  const agentId=result.rows[0]?.agent_id;
  if(!agentId) throw new PersistenceError("NOT_FOUND","Ticket not found");
  return {agentId,owner:{kind:"guest",token}};
}
function frame(event:EventRecord):string {
  const data={ticketId:event.ticketId,sequence:event.sequence,occurredAt:event.createdAt,payload:event.payload};
  return "id: "+event.sequence+"\nevent: "+event.eventType+"\ndata: "+JSON.stringify(data)+"\n\n";
}

export function createApi(db:PersistenceDatabase,queue:TurnQueue) {
  const app=Fastify({
    logger:{redact:["req.headers.cookie","req.headers.authorization","req.body.email","req.body.phone","req.body.name","req.body.company","req.body.description","res.headers.set-cookie"]},
    trustProxy:false,
    bodyLimit:32768,
    maxParamLength:2048,
  });
  const agents=new AgentRepository(db);
  const sessions=new GuestSessionRepository(db);
  const tickets=new TicketRepository(db);
  const messages=new TicketMessageRepository(db);
  const events=new TicketEventRepository(db);
  const leads=new LeadOperations(db);
  const quotes=new QuotationOperations(db);

  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof PersistenceError) {
      const status=error.code==="INVALID_INPUT"?400:error.code==="NOT_FOUND"?404:
        error.code==="CONFLICT"?409:error.code==="NOT_CONFIGURED"?503:500;
      return reply.code(status).send({code:error.code,message:status===500?"Service temporarily unavailable":error.message,requestId:request.id});
    }
    request.log.error({errorCode:(error as Error).name, requestId:request.id},"API request failed");
    return reply.code(500).send({code:"INTERNAL_ERROR",message:"Service temporarily unavailable",requestId:request.id});
  });

  app.get("/api/health",async()=>({status:"ok",service:"api"}));

  app.post<{Params:{agentKey:string}}>("/api/v1/agents/:agentKey/tickets",async(request,reply)=>{
    rejectCrossSite(request);
    const agent=await agents.resolvePublicKey(request.params.agentKey);
    if(!agent || agent.status!=="active") throw new PersistenceError("NOT_FOUND","Agent not found");
    await agents.requireActive(agent.id);
    let token=cookieToken(request);
    if(!token || !(await sessions.isValid(agent.id,token))) {
      token=(await sessions.create(agent.id)).token;
      const host=request.headers.host ?? "";
      const local=host.startsWith("localhost") || host.startsWith("127.0.0.1");
      const secure=process.env.PUBLIC_BASE_URL?.startsWith("https://") ?? false;
      if(!secure && !local && process.env.APP_ENV==="production") {
        throw new PersistenceError("NOT_CONFIGURED","HTTPS is required for public customer sessions");
      }
      reply.header("Set-Cookie","sa_guest="+token+"; Path=/api; HttpOnly; SameSite=Lax"+(secure?"; Secure":""));
    }
    const scope:TicketScope={agentId:agent.id,owner:{kind:"guest",token}};
    const ticket=await tickets.create(scope);
    return reply.code(201).send(ticketView(ticket,agent.key));
  });

  app.get("/api/v1/tickets/:ticketId",async(request)=>{
    const scope=await scopeFromCookie(db,request);
    const id=idParam(request);
    const ticket=await tickets.get(scope,id);
    // Public agent aliases are unscoped; ticket content remains ownership-scoped.
    const alias=(await db.pool.query<{agent_key:string}>(
      "SELECT agent_key FROM agents WHERE id=$1",[scope.agentId])).rows[0]?.agent_key;
    if(!alias) throw new PersistenceError("NOT_FOUND","Ticket not found");
    const history=await messages.listTicketMessages(scope,id,"0",200);
    return {ticket:ticketView(ticket,alias),messages:history.map(messageView)};
  });

  app.post("/api/v1/tickets/:ticketId/messages",async(request,reply)=>{
    rejectCrossSite(request);
    const scope=await scopeFromCookie(db,request);
    const id=idParam(request);
    if(!request.body || typeof request.body!=="object" || Array.isArray(request.body)) {
      throw new PersistenceError("INVALID_INPUT","Message payload required");
    }
    const body=request.body as Record<string,unknown>;
    if(Object.keys(body).some(k=>k!=="text"&&k!=="requestId") ||
      typeof body["requestId"]!=="string" || typeof body["text"]!=="string") {
      throw new PersistenceError("INVALID_INPUT","Invalid message payload");
    }
    const result=await messages.createCustomerMessage(scope,id,body["requestId"],body["text"]);
    await queue.enqueue(scope,id,result.message.id,body["requestId"]);
    return reply.code(202).send({ticketId:id,messageId:result.message.id,requestId:body["requestId"],status:"accepted"});
  });

  const downloadSourceHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    rejectCrossSite(request);
    const ticketId = idParam(request);
    let scope: TicketScope;
    try {
      scope = await scopeFromCookie(db, request);
    } catch {
      const activeAgents = await db.pool.query<{ id: string }>("SELECT id FROM agents WHERE status = 'active'");
      let foundAgentId: string | null = null;
      for (const ag of activeAgents.rows) {
        const found = await db.withAgent(ag.id, async client => {
          const res = await client.query<{ id: string }>("SELECT id FROM tickets WHERE id = $1", [ticketId]);
          return res.rows[0]?.id ?? null;
        });
        if (found) {
          foundAgentId = ag.id;
          break;
        }
      }
      if (!foundAgentId) throw new PersistenceError("NOT_FOUND", "Ticket not found");
      scope = workerTicketScope(foundAgentId, ticketId);
    }

    const rawSourceId =
      (request.params as Record<string, string>)["sourceId"] ||
      ((request.query || {}) as Record<string, string>)["sourceId"] ||
      ((request.query || {}) as Record<string, string>)["source"];
    if (!rawSourceId) throw new PersistenceError("NOT_FOUND", "Source document not found");
    const sourceId = decodeURIComponent(rawSourceId);

    const history = await messages.listTicketMessages(scope, ticketId, "0", 200);
    let targetRef: SourceReference | undefined;
    const allRefs: SourceReference[] = [];
    for (const msg of history) {
      for (const ref of msg.sourceReferences ?? []) {
        allRefs.push(ref);
        if (
          ref.sourceId === sourceId ||
          decodeURIComponent(ref.sourceId) === sourceId ||
          ref.sourceId.includes(sourceId) ||
          sourceId.includes(ref.sourceId)
        ) {
          targetRef = ref;
          break;
        }
      }
      if (targetRef) break;
    }
    if (!targetRef && allRefs.length > 0) {
      if (/^\d+$/.test(sourceId)) {
        targetRef = allRefs[parseInt(sourceId, 10) % allRefs.length];
      } else {
        targetRef = allRefs[0];
      }
    }
    if (!targetRef) {
      throw new PersistenceError("NOT_FOUND", "Source document not found for this ticket");
    }

    const binding = await agents.getPinnedForTicket(scope, ticketId);
    if (!binding.foundryProjectEndpoint) {
      throw new PersistenceError("NOT_CONFIGURED", "Foundry project endpoint not configured");
    }

    const foundry = new FoundryClient(new AgentToolRegistry(), {
      projectEndpoint: binding.foundryProjectEndpoint,
      defaultAgentName: binding.foundryAgentName,
      defaultAgentVersion: binding.foundryAgentVersion,
    });
    const file = await foundry.downloadFile(sourceId, targetRef.title ?? undefined);
    reply.header("Content-Type", file.mimeType);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
    reply.header("Cache-Control", "private, no-cache, no-store");
    return reply.send(file.data);
  };

  app.get<{Params:{ticketId:string;sourceId:string}}>("/api/v1/tickets/:ticketId/sources/:sourceId/download", downloadSourceHandler);
  app.get<{Params:{ticketId:string}}>("/api/v1/tickets/:ticketId/sources/download", downloadSourceHandler);

  // Customer-initiated operation only; never callable as a model tool.
  // Consent is collected in a separate UI form and recorded in Node.
  app.post("/api/v1/tickets/:ticketId/operations/salesforce-lead",async(request,reply)=>{
    rejectCrossSite(request);
    const scope=await scopeFromCookie(db,request);
    const ticketId=idParam(request);
    const submitted=await leads.submit(scope,ticketId,request.body);
    return reply.code(submitted.duplicated?200:202).send(submitted);
  });

  app.get("/api/v1/tickets/:ticketId/operations",async(request)=>{
    const scope=await scopeFromCookie(db,request);
    const ticketId=idParam(request);
    return {enabled:leadDispatchEnabled(),operations:await leads.list(scope,ticketId)};
  });

  // Customer-owned, explicitly acknowledged, pinned-price quotation requests.
  app.get("/api/v1/tickets/:ticketId/quotation-options",async request=>{
    const scope=await scopeFromCookie(db,request);
    return quotes.options(scope,idParam(request));
  });

  app.post("/api/v1/tickets/:ticketId/quotations",async(request,reply)=>{
    rejectCrossSite(request);
    const scope=await scopeFromCookie(db,request);
    const result=await quotes.submit(scope,idParam(request),request.body);
    return reply.code(result.duplicated?200:202).send(result);
  });

  app.get("/api/v1/tickets/:ticketId/quotations",async request=>{
    const scope=await scopeFromCookie(db,request);
    return {quotation:await quotes.get(scope,idParam(request))};
  });

  app.get("/api/v1/tickets/:ticketId/quotations/:quotationId/pdf",async(request,reply)=>{
    const scope=await scopeFromCookie(db,request);
    const ticketId=idParam(request);
    const params=request.params as Record<string,unknown>;
    const quotationId=params["quotationId"];
    if(typeof quotationId!=="string"||!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(quotationId)){
      throw new PersistenceError("NOT_FOUND","Quotation PDF unavailable");
    }
    const doc=await quotes.pdf(scope,ticketId,quotationId);
    return reply.code(200)
      .header("Content-Type","application/pdf")
      .header("Content-Disposition",`attachment; filename="${doc.documentNumber}.pdf"`)
      .header("Cache-Control","private, no-store")
      .header("X-Content-Type-Options","nosniff")
      .header("Content-Security-Policy","sandbox")
      .header("Content-Length",String(doc.bytes.length))
      .send(doc.bytes);
  });

  app.get("/api/events/tickets/:ticketId",async(request,reply)=>{
    const scope=await scopeFromCookie(db,request);
    const id=idParam(request);
    await tickets.get(scope,id);
    const last=request.headers["last-event-id"];
    const cursor=typeof last==="string" ? last:"0";
    if(!/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor)>9223372036854775807n) {
      throw new PersistenceError("INVALID_INPUT","Invalid event cursor");
    }
    reply.hijack();
    const res=reply.raw;
    res.writeHead(200,{
      "Content-Type":"text/event-stream; charset=utf-8",
      "Cache-Control":"no-cache, no-transform",
      "Connection":"keep-alive",
      "X-Accel-Buffering":"no",
    });
    let stopped=false;
    let busy=false;
    let sequence=cursor;
    const stop=()=>{stopped=true;clearInterval(poll);clearInterval(heartbeat);};
    const pull=async()=>{
      if(stopped||busy) return;
      busy=true;
      try {
        let batch:EventRecord[];
        do {
          batch=await events.listAfter(scope,id,sequence,100);
          for(const event of batch) {
            if(stopped) break;
            const ok=res.write(frame(event));
            sequence=event.sequence;
            if(!ok) {
              await new Promise<void>(resolve=>{
                const resume=()=>{res.off("close",resume);res.off("drain",resume);resolve();};
                res.once("drain",resume);res.once("close",resume);
              });
            }
          }
        } while(!stopped&&batch.length===100);
      } catch(error) {
        request.log.warn({errorCode:(error as Error).name,requestId:request.id},"SSE replay failed");
        stop();
        res.end();
      } finally {busy=false;}
    };
    const poll=setInterval(()=>{void pull();},1200);
    const heartbeat=setInterval(()=>{if(!stopped) res.write(": heartbeat\n\n");},20000);
    poll.unref();heartbeat.unref();
    res.on("close",stop);
    res.write(": connected\n\n");
    void pull();
  });
  return app;
}
