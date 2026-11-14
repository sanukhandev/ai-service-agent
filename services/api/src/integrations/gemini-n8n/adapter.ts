/**
 * Gemini-independent, Node-owned ANCFZ business-operation bridge.
 * This consumes an already-authorized PostgreSQL outbox claim; a model
 * proposal, browser request or successful HTTP status is never authority.
 */
import { createHash } from 'node:crypto';

export type OperationKey = 'ancfz_salesforce_lead' | 'ancfz_render_quote' |
  'ancfz_otp_email' | 'ancfz_payment_link' | 'ancfz_payment_verify';
export type DurableState = 'verified_completed' | 'retryable_failure' | 'unknown_outcome' | 'terminal_failed';
export interface DispatchScope { readonly agentId: string; readonly ticketId: string; readonly operationId: string }
export interface Claim extends DispatchScope {
  readonly key: OperationKey;
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface Outcome {
  readonly state: DurableState;
  readonly reason: string;
  readonly providerReference: string | null;
  readonly evidence: Readonly<Record<string, unknown>> | null;
  readonly pdf?: { readonly bytes: Buffer; readonly sha256: string };
}
export interface OperationStore {
  /** Atomic pending -> leased / queued -> running with agent+ticket+consent+prerequisite checks. */
  claim(scope: DispatchScope): Promise<Claim | null>;
  /** Atomic compare-and-set, including provider evidence and ticket event. */
  finish(claim: Claim, outcome: Outcome): Promise<boolean>;
  /** Expired leases are quarantined; they must not be blindly retried. */
  quarantine(agentId: string): Promise<number>;
}
export interface WorkflowSnapshot { readonly name: string; readonly active: boolean; readonly path: string; readonly method: string; readonly headerAuth: boolean }
export interface WorkflowRegistry { current(): Promise<readonly WorkflowSnapshot[]> }
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ROUTES = Object.freeze({
  ancfz_salesforce_lead: { path: 'ancfz/salesforce-lead', name: 'ANCFZ | Salesforce Apex REST AI Chatbot Lead' },
  ancfz_render_quote: { path: 'ancfz/render-pdf', name: 'ANCFZ | PDF Quotation or Invoice' },
  ancfz_otp_email: { path: 'ancfz/otp-email', name: 'ANCFZ | Deliver Payment OTP (Node Generated)' },
  ancfz_payment_link: { path: 'ancfz/payment-link', name: 'ANCFZ | MockGateway Demo Order Request (checkout URL if provided)' },
  ancfz_payment_verify: { path: 'ancfz/payment-verify', name: 'ANCFZ | MockGateway Demo Orders Status (Fail Closed Until Verified)' },
} as const);
const MOCK_OTP = 'ANCFZ | MOCK OTP Data Table Delivery (LOCAL ONLY)';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD = /^00Q(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/;
const KEYS = new Set<string>(Object.keys(ROUTES));
function record(x: unknown): Record<string, unknown> | null { return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null; }
function uncertain(reason: string): Outcome { return { state: 'unknown_outcome', reason, providerReference: null, evidence: null }; }
function terminal(reason: string): Outcome { return { state: 'terminal_failed', reason, providerReference: null, evidence: null }; }
function retryable(reason: string): Outcome { return { state: 'retryable_failure', reason, providerReference: null, evidence: null }; }
function verified(reason: string, ref: string, evidence: Record<string, unknown>, pdf?: Outcome['pdf']): Outcome {
  return { state: 'verified_completed', reason, providerReference: ref, evidence, ...(pdf ? { pdf } : {}) };
}

/** Fail closed unless the operator-side n8n inventory proves exactly one active matching webhook. */
export function validateActiveWorkflow(key: OperationKey, inventory: readonly WorkflowSnapshot[], mockOtp: boolean): void {
  if (!KEYS.has(key)) throw new Error('UNSUPPORTED_OPERATION');
  const smtp = inventory.filter(x => x.active && x.name === ROUTES.ancfz_otp_email.name);
  const mock = inventory.filter(x => x.active && x.name === MOCK_OTP);
  if (smtp.length + mock.length > 1) throw new Error('OTP_WEBHOOK_CONFLICT');
  if (key === 'ancfz_otp_email' && !mockOtp && mock.length > 0) throw new Error('OTP_DELIVERY_MODE_MISMATCH');
  if (key === 'ancfz_otp_email' && mockOtp && (process.env.APP_ENV !== 'development' || process.env.ANCFZ_OTP_MOCK_ENABLED !== 'true'))
    throw new Error('MOCK_OTP_FORBIDDEN');
  const required = key === 'ancfz_otp_email' && mockOtp ? MOCK_OTP : ROUTES[key].name;
  const matched = inventory.filter(x => x.active && x.name === required);
  if (matched.length !== 1 || matched[0]?.path !== ROUTES[key].path || matched[0]?.method !== 'POST' || !matched[0]?.headerAuth)
    throw new Error('WORKFLOW_NOT_VERIFIED_ACTIVE');
}

/** Reject a corrupted or model-constructed payload even if a caller misuses the store interface. */
export function validateClaim(c: Claim): void {
  if (!ID.test(c.agentId) || !ID.test(c.ticketId) || !ID.test(c.operationId) || !ID.test(c.outboxId) ||
      !c.idempotencyKey || c.idempotencyKey.length > 200 || !KEYS.has(c.key) || c.payload.agentKey !== 'ancfz' || c.payload.ticketId !== c.ticketId)
    throw new Error('INVALID_AUTHORIZED_CLAIM');
  const p = c.payload;
  if (c.key === 'ancfz_salesforce_lead') {
    if (p.consent !== true || !['name','company','phone','email','description'].every(k => typeof p[k] === 'string' && !!(p[k] as string).trim()))
      throw new Error('CONSENT_OR_FACTS_MISSING');
  } else if (c.key === 'ancfz_render_quote') {
    if (p.documentType !== 'quotation' || typeof p.documentNumber !== 'string' || !Array.isArray(p.lines) || p.lines.length === 0 ||
        !Number.isFinite(p.total) || typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency))
      throw new Error('UNSUPPORTED_DOCUMENT_OR_PRICE');
  } else if (c.key === 'ancfz_otp_email') {
    if (typeof p.email !== 'string' || typeof p.otp !== 'string' || !/^\d{6}$/.test(p.otp) ||
        (p.deliveryMode === 'mock_datatable' && (p.testOnly !== true || !p.email.endsWith('@example.invalid'))))
      throw new Error('INVALID_OTP_DELIVERY');
  } else if (c.key === 'ancfz_payment_link') {
    if (p.customerConsent !== true || p.otpVerified !== true || p.currency !== 'AED' || typeof p.amount !== 'string' ||
        !/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(p.amount) || typeof p.quotationId !== 'string' || !ID.test(p.quotationId))
      throw new Error('PAYMENT_AUTHORIZATION_MISSING');
  } else if (c.key === 'ancfz_payment_verify') {
    if (typeof p.orderReference !== 'string' || !p.orderReference || typeof p.externalReference !== 'string' ||
        !p.externalReference.startsWith('ANCFZ-') || p.currency !== 'AED' || typeof p.amount !== 'string')
      throw new Error('PAYMENT_REFERENCE_MISSING');
  }
  const forbidden = ['url','webhookPath','webhookUrl','workflowId','agentId','credentials','callbackUrl','endpoint'];
  if (forbidden.some(k => Object.hasOwn(p,k))) throw new Error('ARBITRARY_DISPATCH_FORBIDDEN');
  if (c.key === 'ancfz_salesforce_lead' && Object.keys(p).some(k => !['agentKey','ticketId','consent','name','company','phone','email','description'].includes(k)))
    throw new Error('ARBITRARY_DISPATCH_FORBIDDEN');
}

/** The fixed webhook response is only evidence after operation-specific checks. */
export function evaluateResponse(c: Claim, raw: unknown): Outcome {
  const r = record(raw);
  if (!r || r.ticketId !== c.ticketId) return uncertain('MALFORMED_OR_MISMATCHED_RESPONSE');
  if (c.key === 'ancfz_salesforce_lead') {
    if (r.status === 'verified_completed' && r.verified === true && typeof r.leadId === 'string' && LEAD.test(r.leadId) && r.provider === 'salesforce_apex_rest')
      return verified('SALESFORCE_LEAD_ID_VALIDATED', r.leadId, { provider: r.provider, leadId: r.leadId, ticketId: r.ticketId });
    return uncertain('SALESFORCE_NOT_VERIFIED');
  }
  if (c.key === 'ancfz_render_quote') {
    if (r.status !== 'generated' || r.documentType !== 'quotation' || r.documentNumber !== c.payload.documentNumber ||
        r.mimeType !== 'application/pdf' || typeof r.pdfBase64 !== 'string' || r.pdfBase64.length > 7_000_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(r.pdfBase64)) return uncertain('PDF_EVIDENCE_MISSING');
    const bytes = Buffer.from(r.pdfBase64, 'base64');
    if (bytes.length < 100 || bytes.length > 5_242_880 || bytes.toString('ascii',0,5) !== '%PDF-' ||
        !bytes.subarray(-1024).toString('ascii').includes('%%EOF') || bytes.toString('base64') !== r.pdfBase64)
      return uncertain('PDF_INVALID');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return verified('PDF_BYTES_VALIDATED', String(r.documentNumber), { ticketId: c.ticketId, documentNumber: r.documentNumber, sha256 }, { bytes, sha256 });
  }
  if (c.key === 'ancfz_otp_email') {
    // SMTP acceptance does not verify delivery. The mock explicitly declares delivered=false.
    return uncertain('OTP_DELIVERY_NOT_INDEPENDENTLY_CONFIRMED');
  }
  if (c.key === 'ancfz_payment_link') {
    // Order creation and a checkout URL do not establish a completed payment.
    if (r.quotationId !== c.payload.quotationId || r.externalReference !== c.payload.externalReference ||
        r.amount !== c.payload.amount || r.currency !== c.payload.currency) return uncertain('ORDER_CORRELATION_MISMATCH');
    return uncertain('ORDER_ACK_NOT_PAYMENT_EVIDENCE');
  }
  // The supplied demo Orders workflow returns verification_unconfigured, never confirmed payment.
  if (c.key === 'ancfz_payment_verify') return terminal('GATEWAY_VERIFICATION_UNCONFIGURED');
  return terminal('UNSUPPORTED_OPERATION');
}

/** Read-only n8n API inventory, separately authenticated from business webhooks. */
export class N8nInventory implements WorkflowRegistry {
  constructor(private readonly apiKey: string, private readonly fetcher: FetchLike = fetch) {
    if (apiKey.length < 32) throw new Error('N8N_API_KEY_REQUIRED');
  }
  async current(): Promise<readonly WorkflowSnapshot[]> {
    const entries: WorkflowSnapshot[] = [];
    let cursor: string | undefined;
    for (let page=0;page<10;page++) {
      const suffix = cursor ? '?limit=100&cursor='+encodeURIComponent(cursor) : '?limit=100';
      const response = await this.fetcher('http://n8n:5678/api/v1/workflows'+suffix, { headers: { 'X-N8N-API-KEY': this.apiKey }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('N8N_INVENTORY_UNAVAILABLE');
      const body = await readJson(response, 2_000_000);
      const data = record(body);
      if (!data || !Array.isArray(data.data)) throw new Error('N8N_INVENTORY_INVALID');
      for (const raw of data.data) {
        const item = record(raw);
        if (!item || typeof item.name !== 'string' || typeof item.active !== 'boolean') continue;
        if (!Object.values(ROUTES).some(v=>v.name===item.name) && item.name!==MOCK_OTP) continue;
        if (typeof item.id !== 'string') throw new Error('N8N_INVENTORY_INVALID');
        const detail = await this.fetcher('http://n8n:5678/api/v1/workflows/'+encodeURIComponent(item.id), { headers: { 'X-N8N-API-KEY': this.apiKey }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!detail.ok) throw new Error('N8N_INVENTORY_UNAVAILABLE');
        const detailObj = record(await readJson(detail, 2_000_000));
        const nodes = Array.isArray(detailObj?.nodes) ? detailObj.nodes : [];
        const hooks = nodes.map(record).filter((n):n is Record<string,unknown>=>!!n && n.type==='n8n-nodes-base.webhook');
        if (hooks.length!==1) throw new Error('N8N_WEBHOOK_DEFINITION_INVALID');
        const p=record(hooks[0]?.parameters);
        entries.push({ name:item.name, active:item.active, path:String(p?.path??''), method:String(p?.httpMethod??''), headerAuth:p?.authentication==='headerAuth' });
      }
      if (typeof data.nextCursor !== 'string' || !data.nextCursor) return entries;
      cursor=data.nextCursor;
    }
    throw new Error('N8N_INVENTORY_INCOMPLETE');
  }
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(result.value));
    }
  } finally { await reader.cancel().catch(()=>{}); }
  try { return JSON.parse(Buffer.concat(chunks,total).toString('utf8')); }
  catch { throw new Error('MALFORMED_RESPONSE'); }
}

export class GeminiN8nBridge {
  constructor(
    private readonly store: OperationStore,
    private readonly workflows: WorkflowRegistry,
    private readonly secret: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 30000,
  ) {
    if (secret.length < 32) throw new Error('N8N_WEBHOOK_SECRET_REQUIRED');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('INVALID_TIMEOUT');
  }

  async dispatch(scope: DispatchScope): Promise<{ dispatched: boolean; outcome: Outcome | null }> {
    const claim = await this.store.claim(scope);
    if (!claim) return { dispatched: false, outcome: null }; // Already claimed/completed; no replay.
    let result: Outcome;
    let sentToWebhook = false;
    try {
      validateClaim(claim);
      const mock = claim.key === 'ancfz_otp_email' && claim.payload.deliveryMode === 'mock_datatable';
      validateActiveWorkflow(claim.key, await this.workflows.current(), mock);
      const route = ROUTES[claim.key];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        sentToWebhook = true;
        const response = await this.fetcher('http://n8n:5678/webhook/'+route.path, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-ANCFZ-Workflow-Key': this.secret },
          body: JSON.stringify(claim.payload),
        });
        if (!response.ok) result = uncertain('N8N_HTTP_NOT_PROOF');
        else result = evaluateResponse(claim, await readJson(response, claim.key === 'ancfz_render_quote' ? 7_200_000 : 32_768));
      } finally { clearTimeout(timer); }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      // Pre-dispatch policy failure is terminal; unknown transport/provider outcome is quarantined.
      result = /^(INVALID_AUTHORIZED_CLAIM|CONSENT_OR_FACTS_MISSING|UNSUPPORTED_DOCUMENT_OR_PRICE|INVALID_OTP_DELIVERY|PAYMENT_AUTHORIZATION_MISSING|PAYMENT_REFERENCE_MISSING|ARBITRARY_DISPATCH_FORBIDDEN|UNSUPPORTED_OPERATION|MOCK_OTP_FORBIDDEN|OTP_WEBHOOK_CONFLICT|OTP_DELIVERY_MODE_MISMATCH)$/.test(msg)
        ? terminal(msg) : !sentToWebhook ? retryable('N8N_NOT_READY_BEFORE_DISPATCH') : uncertain('DISPATCH_OR_VERIFICATION_UNCERTAIN');
    }
    await this.store.finish(claim,result);
    return { dispatched: true, outcome: result };
  }

  quarantine(agentId: string): Promise<number> { return this.store.quarantine(agentId); }
}
