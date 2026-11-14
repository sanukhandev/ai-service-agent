#!/usr/bin/env node
/** P6 certification entry point. Node >=22. No third-party dependencies or credentials for offline mode. */
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOfflineAdapter } from '../tests/gemini/adapters/offline.mjs';
import { Blocked, cases, loadFixtures } from '../tests/gemini/certification.mjs';

const rootDefault = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = Object.fromEntries(process.argv.slice(2).map(s => {const [k,...v]=s.replace(/^--/,'').split('=');return [k,v.length?v.join('='):true];}));
if (argv.help) {
  console.log('Usage: node scripts/check-gemini-certification.mjs --mode=offline|local|live [--adapter=absolute/module.mjs] [--exact-sha=40hex] [--report=path] [--strict]');
  process.exit(0);
}
const mode = argv.mode || 'offline';
if (!['offline','local','live'].includes(mode)) throw new Error('Invalid --mode');
const root = resolve(argv.root || rootDefault);
await loadFixtures(root);
const expectedSha = argv['exact-sha'] || process.env.GEMINI_CERT_EXACT_SHA || null;
let checkoutSha = null;
try {checkoutSha = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();} catch { /* Not necessarily a Git checkout in a fixture-only run. */ }
let adapter = null;
let adapterBlocked = null;
let identity = null;
if (mode === 'offline') {
  adapter = { create: createOfflineAdapter };
  identity = { mode, evidenceLevel:'mock-policy-simulation', exactSha:checkoutSha };
} else {
  const adapterPath = argv.adapter || process.env.GEMINI_CERT_ADAPTER;
  const gate = [];
  if (!/^[a-f0-9]{40}$/i.test(expectedSha || '')) gate.push('exact integrated --exact-sha is required');
  if (!checkoutSha) gate.push('repository checkout SHA unavailable');
  if (expectedSha && checkoutSha && expectedSha !== checkoutSha) gate.push('checkout does not match --exact-sha');
  if (!adapterPath) gate.push('real adapter module not configured');
  if (mode === 'live') {
    if (argv['live-confirm'] !== 'I_AUTHORIZE_SANDBOX_GEMINI_CERTIFICATION') gate.push('explicit sandbox authorization absent');
    if (!process.env.GEMINI_CERT_APPROVED_STORES) gate.push('approved File Search test stores not configured');
    if (!process.env.GEMINI_CERT_SANDBOX_ENDPOINT) gate.push('sandbox integration endpoint not configured');
  }
  if (gate.length) adapterBlocked = gate.join('; ');
  else {
    try {
      const external = await import(pathToFileURL(resolve(adapterPath)).href);
      if (typeof external.createCertificationAdapter !== 'function') throw new Error('module must export createCertificationAdapter');
      adapter = { create: () => external.createCertificationAdapter({mode,exactSha:expectedSha,root}) };
      identity = await external.certificationIdentity?.({mode,exactSha:expectedSha,root});
      if (!identity || identity.mode!==mode || identity.exactSha!==expectedSha || identity.evidenceLevel !== (mode==='live'?'live-provider':'local-integration')) {
        throw new Error('adapter identity/attestation does not match requested run');
      }
    } catch(e) {adapter = null;adapterBlocked='Adapter load/identity validation failed: '+e.message;}
  }
}
const observed = [];
for (const t of cases()) {
  const begun = performance.now();
  let state = 'passed', reason = null, details = null;
  try {
    const a = t.area === 'infrastructure' ? null : (adapter ? await adapter.create() : null);
    // Infrastructure tests without external probes remain explicitly blocked, not silently passed.
    if (t.area === 'infrastructure' && mode!=='offline' && adapterBlocked) {
      // Still execute repo-static checks; runtime probes remain blocked inside the case.
    }
    details = await t.run(a,{root,mode,exactSha:expectedSha,identity});
  } catch (error) {
    state = error instanceof Blocked ? 'blocked' : 'failed';
    reason = String(error?.message || error);
  }
  if (!adapter && t.area!=='infrastructure' && state==='blocked' && adapterBlocked) reason=adapterBlocked;
  observed.push({id:t.id,area:t.area,mode,evidenceLevel:t.area==='infrastructure'?'static-or-blocked':identity?.evidenceLevel??null,state,reason,details:details??null,executionOverheadMs:Math.round((performance.now()-begun)*1000)/1000});
}
const count = k => observed.filter(r=>r.state===k).length;
const knowledge = observed.filter(r=>r.area==='knowledge' && r.details?.observed);
const grounded = knowledge.filter(r=>r.details.goldenExpected==='supported');
const negative = knowledge.filter(r=>r.details.goldenExpected!=='supported');
const checkedSources = knowledge.reduce((s,r)=>s+(r.details.observed.checkedEvidenceCount||0),0);
const acceptedSources = knowledge.reduce((s,r)=>s+(r.details.observed.authorizedEvidenceCount||0),0);
const latency = knowledge.map(r=>r.details.observed.latencyMs).filter(v=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b);
const percentile=p=>latency.length?latency[Math.max(0,Math.ceil(latency.length*p)-1)]:null;
const totalTokens = kind => {const samples=knowledge.map(r=>r.details.observed[kind]).filter(v=>Number.isInteger(v)&&v>=0);return samples.length?{samples:samples.length,total:samples.reduce((a,b)=>a+b,0)}:null;};
const costs = knowledge.map(r=>r.details.observed.costUsd).filter(v=>typeof v==='number'&&Number.isFinite(v));
const ratio=(a,b)=>b?Number((a/b).toFixed(5)):null;
const report={
  schema:'gemini-certification-report-v1',mode,
  evidenceLevel:identity?.evidenceLevel??'none',exactSha:checkoutSha,requestedExactSha:expectedSha,
  generatedAt:new Date().toISOString(),
  certificationPassed:false, // P6 never certifies the integrated application on mocked or partial evidence.
  total:observed.length,passed:count('passed'),failed:count('failed'),skipped:count('skipped'),blocked:count('blocked'),
  metrics:{
    groundedResponseAccuracy:ratio(knowledge.filter(r=>r.state==='passed').length,knowledge.length),
    unsupportedClaimEscapeRate:ratio(negative.filter(r=>r.details.observed.published||r.details.observed.streamed).length,negative.length),
    falseRejectionRate:ratio(grounded.filter(r=>!r.details.observed.published).length,grounded.length),
    sourceAuthorizationAccuracy:ratio(acceptedSources,checkedSources),
    toolAuthorizationFailures:observed.filter(r=>r.area==='tool_workflow'&&r.state==='failed').length,
    sessionIsolation:{passed:observed.filter(r=>r.area==='session'&&r.state==='passed').length,failed:observed.filter(r=>r.area==='session'&&r.state==='failed').length,blocked:observed.filter(r=>r.area==='session'&&r.state==='blocked').length},
    duplicateWorkflowActionCount:null, // Only measured from audited real outbox/provider dispatch traces.
    responseLatencyMs:{p50:percentile(.5),p95:percentile(.95),samples:latency.length},
    usage:{inputTokens:totalTokens('inputTokens'),outputTokens:totalTokens('outputTokens'),costUsd:costs.length?{samples:costs.length,total:costs.reduce((a,b)=>a+b,0)}:null},
  },
  blockers:[...new Set(observed.filter(r=>r.state==='blocked').map(r=>r.reason))],
  cases:observed,
};
const filepath=resolve(root,argv.report||`tests/gemini/reports/latest-${mode}.json`);
await mkdir(dirname(filepath),{recursive:true});
await writeFile(filepath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(`Gemini P6 ${mode}: ${report.total} cases; ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ${report.blocked} blocked`);
console.log(`Evidence: ${report.evidenceLevel}; exact checkout: ${report.exactSha||'unavailable'}; certification: NOT ESTABLISHED`);
console.log(`Report: ${filepath}`);
if (report.failed) process.exitCode=1;
else if ((argv.strict || mode!=='offline') && report.blocked) process.exitCode=2;
