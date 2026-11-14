#!/usr/bin/env node
/**
 * Zero-provider-call, zero-write readiness check for the isolated Gemini POC.
 * Run: node --env-file=.env scripts/check-gemini-live-readiness.mjs --scope=chat --docker --db --health
 * A passing preflight NEVER certifies Gemini/File Search/n8n behavior.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scopes = new Set(['chat', 'knowledge', 'workflow', 'payment']);
const alpha = /^[A-Za-z0-9_.-]{3,80}$/;
const key32 = /^[a-f\d]{64}$/i;
const forbiddenPublicModes = new Set(['production', 'staging']);

export function assessConfiguration(env, scope = 'chat') {
  if (!scopes.has(scope)) throw new Error('INVALID_SCOPE');
  const checks = [];
  function add(name, ok, detail) {
    checks.push({ name, status: ok ? 'pass' : 'fail', detail: ok ? 'configured' : detail });
  }
  const val = (name, fallback = '') => String(env[name] ?? fallback).trim();
  add('isolated_compose_project',
    val('COMPOSE_PROJECT_NAME') === 'ai-service-agent-gemini',
    'Use the isolated ai-service-agent-gemini Compose project.');
  add('isolated_database',
    val('POSTGRES_DB', 'ai_service_agent_gemini') === 'ai_service_agent_gemini',
    'Do not point the experiment at any other PostgreSQL database.');
  add('runtime_environment',
    val('APP_ENV', 'development') === 'development',
    'Local POC uses APP_ENV=development, never a public production host.');
  const url = val('PUBLIC_BASE_URL', 'http://localhost:2000');
  let localUrl = false;
  try {
    const u = new URL(url);
    localUrl = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) &&
      u.port === '2000' && u.pathname === '/' && !u.search && !u.hash &&
      !u.username && !u.password;
  } catch { /* invalid base URL */ }
  add('loopback_only_ingress', localUrl,
    'Set PUBLIC_BASE_URL=http://localhost:2000; never expose this POC publicly.');
  add('gemini_api_key', val('GEMINI_API_KEY').length >= 20,
    'Set GEMINI_API_KEY privately. Never commit the key.');
  add('encrypted_function_continuation', key32.test(val('GEMINI_STATE_ENCRYPTION_KEY')),
    'GEMINI_STATE_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  add('supported_model_identifier', alpha.test(val('GEMINI_MODEL_ID', 'gemini-3.8-flash')) &&
      val('GEMINI_MODEL_ID', 'gemini-3.8-flash').startsWith('gemini-'),
    'Use a currently available Gemini model ID; check account access during G1.');
  const dbOwner = val('POSTGRES_PASSWORD'), dbRuntime = val('POSTGRES_APP_PASSWORD');
  add('isolated_database_credentials', dbOwner.length >= 16 &&
      dbRuntime.length >= 16 && dbOwner !== dbRuntime,
    'Set distinct, private POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD values of at least 16 characters.');
  const financialEnabled = val('ANCFZ_PAYMENT_DISPATCH_ENABLED', 'false') === 'true';
  if (scope !== 'payment') {
    add('payment_dispatch_disabled', !financialEnabled,
      'Keep ANCFZ_PAYMENT_DISPATCH_ENABLED=false outside separately approved payment sandbox tests.');
  }
  if (val('IDENTITY_OCR_PROVIDER', 'azure') === 'gemini_vision') {
    add('synthetic_only_vision_ocr',
      val('ALLOW_SYNTHETIC_GEMINI_OCR', 'NO') === 'YES' &&
      !forbiddenPublicModes.has(val('APP_ENV', 'development')),
      'Gemini OCR may be used only with explicit synthetic development documents.');
  }
  if (scope === 'knowledge' || scope === 'workflow' || scope === 'payment') {
    add('file_search_model_identifier', alpha.test(val('GEMINI_FILE_SEARCH_MODEL')),
      'Set GEMINI_FILE_SEARCH_MODEL to a model supported by Gemini File Search.');
    add('approved_text_mount', existsSync(resolve(val('GEMINI_APPROVED_TEXT_ROOT_HOST',
      './private/gemini-approved'))),
    'Create a private approved-text directory, and publish the Sara knowledge version before factual tests.');
  }
  if (scope === 'workflow' || scope === 'payment') {
    add('private_n8n_encryption_key', val('N8N_ENCRYPTION_KEY').length >= 32,
      'Configure a separate persistent N8N_ENCRYPTION_KEY of at least 32 characters.');
    add('authorized_n8n_header_secret', val('ANCFZ_N8N_WEBHOOK_SECRET').length >= 32,
      'Set ANCFZ_N8N_WEBHOOK_SECRET to the private n8n Header Auth credential.');
    add('explicit_lead_approval', val('ANCFZ_LEAD_DISPATCH_ENABLED') === 'true',
      'Enable ANCFZ_LEAD_DISPATCH_ENABLED only after sandbox n8n/Salesforce validation.');
    add('explicit_quote_approval', val('ANCFZ_QUOTE_DISPATCH_ENABLED') === 'true',
      'Enable ANCFZ_QUOTE_DISPATCH_ENABLED only after quotation workflow validation.');
  }
  if (scope === 'payment') {
    add('sandbox_payment_opt_in', financialEnabled &&
      val('ANCFZ_TEST_OTP_ENABLED') === 'true',
      'Enable payment dispatch and test OTP only in an approved isolated sandbox.');
    add('otp_secret', val('ANCFZ_OTP_PEPPER').length >= 32,
      'Set a distinct private ANCFZ_OTP_PEPPER.');
    const azure = val('IDENTITY_OCR_PROVIDER', 'azure') === 'azure' &&
      val('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT').startsWith('https://') &&
      val('AZURE_DOCUMENT_INTELLIGENCE_KEY').length >= 16;
    const synthetic = val('IDENTITY_OCR_PROVIDER') === 'gemini_vision' &&
      val('ALLOW_SYNTHETIC_GEMINI_OCR') === 'YES';
    add('sandbox_document_extraction', azure || synthetic,
      'Configure approved Azure OCR, or synthetic-only Gemini development OCR.');
  }
  return { scope, ready: checks.every(c => c.status === 'pass'), checks,
    note: 'This is configuration readiness only. Provider G1 and sandbox UAT must still pass.' };
}

function externalCommand(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
    env, windowsHide: true,
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}
export function dockerConfigurationCheck(env, scope) {
  const args = ['compose'];
  if (scope === 'workflow' || scope === 'payment') args.push('--profile', 'workflows');
  args.push('config', '--quiet');
  return externalCommand('docker', args, env) !== null;
}
export function checkPublishedSara(env, scope) {
  const sql = [
    "SELECT CASE WHEN a.status = 'active' AND v.provider = 'gemini'",
    " AND v.publication_state = 'published' THEN 'yes' ELSE 'no' END,",
    "(SELECT count(*) FROM intents i JOIN intent_catalog_versions ic",
    " ON ic.id=i.catalog_version_id AND ic.agent_id=i.agent_id",
    " WHERE i.agent_id=a.id AND ic.status='published'),",
    "CASE WHEN v.knowledge_version_id IS NOT NULL AND v.knowledge_status='bound'",
    " AND EXISTS (SELECT 1 FROM gemini_knowledge_versions k",
    " WHERE k.id=v.knowledge_version_id AND k.agent_id=a.id AND k.state='published')",
    " THEN 'yes' ELSE 'no' END",
    "FROM agents a JOIN agent_versions v ON v.id=a.active_version_id",
    " AND v.agent_id=a.id WHERE a.agent_key='ancfz' LIMIT 1;",
  ].join(' ');
  const out = externalCommand('docker', ['compose', 'exec', '-T', 'postgres',
    'psql', '-X', '-q', '-A', '-t', '-F', '|', '-U', 'postgres', '-d',
    String(env.POSTGRES_DB || 'ai_service_agent_gemini'), '-c', sql], env);
  if (!out) return { ok: false, knowledge: false, intentCount: 0,
    reason: 'PostgreSQL unavailable, migrations missing, or Sara not seeded.' };
  const [active, number, knowledge] = out.split('|');
  const intentCount = Number(number);
  return { ok: active === 'yes' && Number.isSafeInteger(intentCount) && intentCount >= 1 &&
      (scope === 'chat' || knowledge === 'yes'),
    knowledge: knowledge === 'yes', intentCount,
    reason: 'Sara must be active with a published Gemini version and catalog. Knowledge scopes also require a bound published File Search version.' };
}
export async function checkLocalHealth(env) {
  const base = String(env.PUBLIC_BASE_URL || 'http://localhost:2000');
  try {
    const response = await fetch(new URL('/api/health', base), {
      signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.status === 'ok' && data?.service === 'api';
  } catch { return false; }
}
async function main() {
  const args = process.argv.slice(2);
  const recognized = new Set(['--docker', '--db', '--health']);
  const named = args.filter(arg => arg.startsWith('--scope='));
  if (named.length > 1 || args.some(arg => !recognized.has(arg) && !arg.startsWith('--scope='))) {
    throw new Error('Usage: --scope=chat|knowledge|workflow|payment [--docker] [--db] [--health]');
  }
  const scope = named[0]?.slice(8) || 'chat';
  const result = assessConfiguration(process.env, scope);
  function add(name, ok, detail) {
    result.checks.push({name, status: ok ? 'pass' : 'fail', detail: ok ? 'verified' : detail});
    if (!ok) result.ready = false;
  }
  if (args.includes('--docker')) {
    add('docker_compose_configuration', dockerConfigurationCheck(process.env, scope),
      'Docker Compose config failed. Check Docker installation, Compose version and isolated .env.');
  }
  if (args.includes('--db')) {
    const db = checkPublishedSara(process.env, scope);
    add('database_agent_and_catalog', db.ok, db.reason);
    if (db.ok && scope === 'chat' && !db.knowledge) {
      result.checks.push({name:'rag_publication',status:'warning',
        detail:'Sara has no published bound knowledge version; only greeting, clarification and approved catalog tools can be evaluated.'});
    }
  }
  if (args.includes('--health')) {
    add('localhost_api_health', await checkLocalHealth(process.env),
      'Start the isolated stack and verify http://localhost:2000/api/health.');
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(JSON.stringify({ ready:false, error: error?.message === 'INVALID_SCOPE' ?
      'INVALID_SCOPE' : 'INVALID_PREFLIGHT_INVOCATION' }));
    process.exitCode = 2;
  });
}
