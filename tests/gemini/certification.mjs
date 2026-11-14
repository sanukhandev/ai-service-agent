import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export class Blocked extends Error { constructor(reason) { super(reason); this.name = 'Blocked'; } }
const hour = 3_600_000;
const list = [];
const add = (id, area, run) => list.push({ id, area, run });
const has = (object, prop) => Object.prototype.hasOwnProperty.call(object, prop);
const requireApi = (adapter, ...methods) => {
  if (!adapter) throw new Blocked('Real local/live adapter not configured');
  for (const method of methods) if (typeof adapter[method] !== 'function') throw new Blocked(`Adapter method ${method} not integrated`);
};
const start = async (a) => { requireApi(a, 'createSession', 'sendMessage', 'getContext', 'session', 'setClock'); return a.createSession(); };
const accept = async (a, id, payload) => {
  const result = await a.sendMessage(id, payload);
  assert.equal(result.status, 'accepted');
  return result;
};

export async function loadFixtures(root) {
  const golden = JSON.parse(await readFile(join(root, 'tests/gemini/fixtures/golden.json'), 'utf8'));
  const security = JSON.parse(await readFile(join(root, 'tests/gemini/fixtures/security.json'), 'utf8'));
  for (const [name, fixtures] of [['golden', golden], ['security', security]]) {
    assert.ok(Array.isArray(fixtures) && fixtures.length > 0, `${name} dataset empty`);
    assert.equal(new Set(fixtures.map(f => f.id)).size, fixtures.length, `${name} IDs not unique`);
    for (const f of fixtures) assert.ok(f.id && f.explanation !== '' && f.expected, `incomplete ${name} fixture`);
  }
  for (const f of golden) {
    assert.ok(f.question && f.category && f.expectedQualification && Array.isArray(f.allowedEvidenceIds) && Array.isArray(f.claims) && f.explanation);
    add(f.id, 'knowledge', async a => {
      requireApi(a, 'evaluateGolden');
      const result = await a.evaluateGolden(f);
      assert.equal(result.category, f.category);
      assert.equal(result.status, f.expected, `${f.id}: ${f.explanation}`);
      assert.equal(result.qualification, f.expectedQualification);
      assert.equal(result.published, f.expectedQualification === 'publish', 'candidate persisted before verification');
      assert.equal(result.streamed, f.expectedQualification === 'publish', 'candidate streamed before verification');
      assert.deepEqual(result.enabledBuiltinTools, ['file_search'], 'web or other builtin accidentally enabled');
      assert.ok((result.usedEvidenceIds ?? []).every(id => f.allowedEvidenceIds.includes(id)), 'unapproved source reference');
      return { goldenExpected: f.expected, observed: result };
    });
  }
  for (const f of security) {
    add(f.id, 'security', async a => {
      requireApi(a, 'probeSecurity');
      const result = await a.probeSecurity(f);
      assert.equal(result.allowed, false, 'unauthorized request accepted');
      assert.equal(result.leaked, false, 'secret or cross-scope content leaked');
      assert.equal(result.externalCalls, 0, 'unexpected external side effects');
      assert.deepEqual(result.enabledBuiltinTools, ['file_search']);
      if (f.kind === 'secrets') assert.ok(!(result.logs ?? []).some(x => x.includes(f.secret)), 'secret reached logs');
      return { securityDenied: true };
    });
  }
}

// Session scenarios deliberately drive adapter primitives, not a canned scenario pass/fail flag.
add('t01-multiple-turns', 'session', async a => { const s = await start(a); await accept(a,s.sessionId,{text:'Start a company',fact:{key:'activity',value:'consultancy'}}); await accept(a,s.sessionId,{text:'I need two visas'}); assert.equal((await a.getContext(s.sessionId)).history.length,2); });
add('t02-remember-facts', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{text:'IT consultancy',fact:{key:'activity',value:'IT consultancy'}}); await accept(a,s.sessionId,{text:'What activity did I give?'}); assert.equal((await a.getContext(s.sessionId)).facts.activity,'IT consultancy'); });
add('t03-correct-fact', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{fact:{key:'visaCount',value:2}}); await accept(a,s.sessionId,{fact:{key:'visaCount',value:3}}); assert.deepEqual((await a.getContext(s.sessionId)).facts,{visaCount:3}); });
add('t04-refresh', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{text:'remember this',fact:{key:'city',value:'Dubai'}}); requireApi(a,'browserRefresh'); const restored=await a.browserRefresh(s.sessionId); assert.equal(restored.sessionId,s.sessionId); assert.equal(restored.facts.city,'Dubai'); });
add('t05-59-minutes', 'session', async a => { const s=await start(a); const old=a.session(s.sessionId).expiresAt; a.setClock(old-60_000); await accept(a,s.sessionId,{text:'Before expiry'}); assert.equal(a.session(s.sessionId).expiresAt,old+59*60_000); });
add('t06-exact-expiry', 'session', async a => { const s=await start(a); a.setClock(a.session(s.sessionId).expiresAt); const r=await accept(a,s.sessionId,{text:'A new conversation'}); assert.notEqual(r.sessionId,s.sessionId); assert.notEqual(r.ticketId,s.ticketId); assert.equal(await a.getContext(s.sessionId),null); });
add('t07-sse-no-slide', 'session', async a => { const s=await start(a); const old=a.session(s.sessionId).expiresAt; requireApi(a,'poll'); a.setClock(old-10); await a.poll(s.sessionId); assert.equal(a.session(s.sessionId).expiresAt,old); });
add('t08-model-no-slide', 'session', async a => { const s=await start(a); const old=a.session(s.sessionId).expiresAt; requireApi(a,'modelReply'); a.setClock(old-100); await a.modelReply(s.sessionId,'Response'); assert.equal(a.session(s.sessionId).expiresAt,old); });
add('t09-redis-flush', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{fact:{key:'activity',value:'trading'}}); requireApi(a,'flushRedis'); await a.flushRedis(); assert.equal((await a.getContext(s.sessionId)).facts.activity,'trading'); });
add('t10-restart-before-expiry', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{text:'prior text'}); requireApi(a,'restartNode'); await a.restartNode(); assert.equal((await a.getContext(s.sessionId)).history[0].text,'prior text'); });
add('t11-restart-after-expiry', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{fact:{key:'secret',value:'old'}}); a.setClock(a.session(s.sessionId).expiresAt); requireApi(a,'restartNode'); await a.restartNode(); const r=await accept(a,s.sessionId,{text:'new'}); assert.notEqual(r.sessionId,s.sessionId); assert.deepEqual((await a.getContext(r.sessionId)).facts,{}); });
add('t12-new-session-no-inheritance', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{fact:{key:'contact',value:'old@example.invalid'}}); const next=await a.createSession(); assert.notEqual(next.ticketId,s.ticketId); const ctx=await a.getContext(next.sessionId); assert.equal(JSON.stringify(ctx).includes('old@example.invalid'),false); });
add('t13-concurrent-expiry', 'session', async a => { const s=await start(a); a.setClock(a.session(s.sessionId).expiresAt); const r=await Promise.all([a.sendMessage(s.sessionId,{text:'a',requestId:'r1'}),a.sendMessage(s.sessionId,{text:'b',requestId:'r2'})]); assert.ok(r.every(x=>x.sessionId!==s.sessionId)); assert.equal((await a.getContext(s.sessionId)),null); assert.ok(r.every(x=>x.status==='accepted')); });
add('t14-provider-state-unavailable', 'session', async a => { const s=await start(a); await accept(a,s.sessionId,{text:'recover from database',fact:{key:'budget',value:'approved'}}); requireApi(a,'addProviderContinuation','loseProviderContinuation'); await a.addProviderContinuation(s.sessionId); await a.loseProviderContinuation(s.sessionId); const ctx=await a.getContext(s.sessionId); assert.equal(ctx.continuation,null); assert.equal(ctx.facts.budget,'approved'); assert.equal(ctx.history[0].text,'recover from database'); });
add('t15-context-compression', 'session', async a => { const s=await start(a); for (let i=0;i<65;i++) await accept(a,s.sessionId,{text:`turn ${i}`,fact:{key:'activeGoal',value:'company_formation'}}); requireApi(a,'compressContext'); const result=await a.compressContext(s.sessionId); assert.equal(result.historyCount,65); assert.equal(result.facts.activeGoal,'company_formation'); assert.ok(result.estimatedModelMessages<result.historyCount); assert.ok(result.summary); });
add('t16-inflight-operation-expiry', 'session', async a => { const s=await start(a); requireApi(a,'proposeAction','providerOutcome'); const op=await a.proposeAction({sessionId:s.sessionId,consent:true,idempotencyKey:'old-operation'}); assert.equal(op.state,'queued'); a.setClock(a.session(s.sessionId).expiresAt); const newer=await accept(a,s.sessionId,{text:'new session'}); await a.providerOutcome(op,{status:'success',verifiedReference:'crm-test-1'}); assert.equal(op.state,'verified'); assert.equal(op.ticketId,s.ticketId); assert.notEqual(newer.ticketId,op.ticketId); assert.equal(JSON.stringify(await a.getContext(newer.sessionId)).includes('crm-test-1'),false); });

const toolCase = (id, fn) => add(id,'tool_workflow', async a=>{requireApi(a,'callBusinessTool','proposeAction','providerOutcome'); const s=await a.createSession(); await fn(a,s);});
toolCase('w01-allowlist',async(a,s)=>{const r=await a.callBusinessTool({sessionId:s.sessionId,name:'execute_shell',callId:'1',argumentsJson:'{}'}); assert.equal(r.status,'TOOL_NOT_AUTHORIZED');});
toolCase('w02-malformed-json',async(a,s)=>{const r=await a.callBusinessTool({sessionId:s.sessionId,name:'find_intents',callId:'1',argumentsJson:'{broken'}); assert.equal(r.status,'MALFORMED_ARGUMENTS');});
toolCase('w03-duplicate-call-id',async(a,s)=>{const args={sessionId:s.sessionId,name:'find_intents',callId:'id-1',argumentsJson:'{}'}; assert.equal((await a.callBusinessTool(args)).status,'ok'); assert.equal((await a.callBusinessTool(args)).status,'DUPLICATE_CALL_ID');});
toolCase('w04-unknown-tool',async(a,s)=>{assert.equal((await a.callBusinessTool({sessionId:s.sessionId,name:'direct_n8n_webhook',callId:'x',argumentsJson:'{}'})).status,'TOOL_NOT_AUTHORIZED');});
toolCase('w05-valid-intent',async(a,s)=>{const r=await a.callBusinessTool({sessionId:s.sessionId,name:'find_intents',callId:'x',argumentsJson:'{}'}); assert.ok(r.items.some(x=>x.key==='company_formation'));});
toolCase('w06-required-fields',async(a,s)=>{const r=await a.callBusinessTool({sessionId:s.sessionId,name:'get_intent_requirements',callId:'x',argumentsJson:'{"intentKey":"company_formation"}'}); assert.ok(r.requirements.includes('contact_email'));});
toolCase('w07-facts-upsert',async(a,s)=>{for(const [id,value] of [['a',2],['b',3]]) {const r=await a.callBusinessTool({sessionId:s.sessionId,name:'record_ticket_facts',callId:id,argumentsJson:JSON.stringify({key:'visaCount',value})});assert.equal(r.count,1);}assert.equal((await a.getContext(s.sessionId)).facts.visaCount,3);});
toolCase('w08-action-consent',async(a,s)=>{assert.equal((await a.proposeAction({sessionId:s.sessionId,consent:false})).state,'denied');});
toolCase('w09-outbox-idempotency',async(a,s)=>{const p={sessionId:s.sessionId,consent:true,idempotencyKey:'stable-1'};const x=await a.proposeAction(p);const y=await a.proposeAction(p);assert.equal(x.idempotencyKey,y.idempotencyKey);assert.equal(y.dispatches,1);});
toolCase('w10-timeout-uncertain',async(a,s)=>{const op=await a.proposeAction({sessionId:s.sessionId,consent:true});await a.providerOutcome(op,{status:'timeout'});assert.equal(op.state,'uncertain');});
toolCase('w11-authoritative-provider-proof',async(a,s)=>{const op=await a.proposeAction({sessionId:s.sessionId,consent:true});await a.providerOutcome(op,{status:'success',verifiedReference:'trusted-provider-test-ref'});assert.equal(op.state,'verified');assert.equal(op.providerReference,'trusted-provider-test-ref');});
toolCase('w12-no-verbal-payment',async(a,s)=>{const op=await a.proposeAction({sessionId:s.sessionId,operation:'payment',consent:true});assert.equal(op.state,'denied');});
toolCase('w13-no-model-webhook',async(a,s)=>{assert.equal((await a.callBusinessTool({sessionId:s.sessionId,name:'n8n_execute',callId:'1',argumentsJson:'{}'})).status,'TOOL_NOT_AUTHORIZED');});
toolCase('w14-ack-not-completed',async(a,s)=>{const op=await a.proposeAction({sessionId:s.sessionId,consent:true});await a.providerOutcome(op,{status:'ack'});assert.notEqual(op.state,'verified');});
toolCase('w15-expired-tool',async(a,s)=>{a.setClock(a.session(s.sessionId).expiresAt);const r=await a.callBusinessTool({sessionId:s.sessionId,name:'find_intents',callId:'1',argumentsJson:'{}'});assert.equal(r.status,'SESSION_EXPIRED');});
toolCase('w16-duplicate-message',async(a,s)=>{const m={text:'same',requestId:'req-1'};const x=await a.sendMessage(s.sessionId,m);const y=await a.sendMessage(s.sessionId,m);assert.equal(x.status,'accepted');assert.equal(y.status,'duplicate');assert.equal((await a.getContext(s.sessionId)).history.length,1);});

const staticCase = (id, fn) => add(id,'infrastructure',async(a,ctx)=>fn(ctx));
const readRoot = async (ctx,p) => {try{return await readFile(join(ctx.root,p),'utf8');} catch {throw new Blocked(`Repository file unavailable: ${p}`);} };
staticCase('i01-compose-project',async ctx=>{assert.match(await readRoot(ctx,'docker-compose.yml'),/^name:\s*ai-service-agent-gemini\s*$/m);});
staticCase('i02-ingress-port',async ctx=>{const c=await readRoot(ctx,'docker-compose.yml');assert.match(c,/127\.0\.0\.1:2000:80/);assert.doesNotMatch(c,/127\.0\.0\.1:80:80/);});
staticCase('i03-dedicated-volumes',async ctx=>{const c=await readRoot(ctx,'docker-compose.yml');for(const name of ['postgres-data','redis-data','n8n-data'])assert.ok(c.includes(`ai-service-agent-gemini-${name}`));});
staticCase('i04-no-shared-credentials',async(_)=>{throw new Blocked('Requires isolated environment fingerprint comparison with Foundry main; static YAML is insufficient');});
staticCase('i05-migration-order',async(_,ctx)=>{throw new Blocked('Requires real PostgreSQL migrations and checksum inspection from integrated P2');});
staticCase('i06-repeated-seeding',async()=>{throw new Blocked('Requires twice-run seed verification against dedicated PostgreSQL from P2');});
staticCase('i07-no-foundry-bootstrap',async ctx=>{const c=await readRoot(ctx,'docker-compose.yml');if(/FOUNDRY_PROJECT_ENDPOINT:|FOUNDRY_AGENT_NAME:|FOUNDRY_AGENT_VERSION:/.test(c))throw new Blocked('G0 Compose still passes Foundry variables; P2/integration owner must remove dependency and verify clean bootstrap');});
staticCase('i08-private-n8n',async(_,ctx)=>{throw new Blocked('Requires negative external HTTP webhook probe and positive backend-network probe');});
staticCase('i09-provider-compatibility',async(_,ctx)=>{throw new Blocked('Requires live Gemini File Search annotations/function continuation and provider request IDs (G1)');});

export function cases() {return list;}
export async function readTargetSha(root) {
  try { const p=join(root,'.git'); const s=await stat(p); if(!s)throw Error('absent'); } catch {return null;}
  return null; // Caller supplies a trusted exact-head SHA; never infer from a named branch.
}
