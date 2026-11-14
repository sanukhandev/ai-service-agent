import test from 'node:test';
import assert from 'node:assert/strict';
import { assessConfiguration } from './check-gemini-live-readiness.mjs';

function valid() {
  return {
    COMPOSE_PROJECT_NAME: 'ai-service-agent-gemini',
    POSTGRES_DB: 'ai_service_agent_gemini',
    APP_ENV: 'development',
    PUBLIC_BASE_URL: 'http://localhost:2000',
    GEMINI_API_KEY: 'synthetic-not-a-real-key-123456',
    GEMINI_STATE_ENCRYPTION_KEY: 'a'.repeat(64),
    GEMINI_MODEL_ID: 'gemini-3.8-flash',
    POSTGRES_PASSWORD: 'synthetic-owner-password-12345',
    POSTGRES_APP_PASSWORD: 'synthetic-runtime-password-67890',
    ANCFZ_PAYMENT_DISPATCH_ENABLED: 'false',
  };
}
test('chat preflight accepts isolated configured demo but never claims live certification', () => {
  const result = assessConfiguration(valid(), 'chat');
  assert.equal(result.ready, true);
  assert.match(result.note, /Provider G1/);
});
test('refuses shared stack or credential exposure', () => {
  for (const [name,value] of [
    ['COMPOSE_PROJECT_NAME','ai-service-agent'],
    ['POSTGRES_DB','prod_database'],
    ['PUBLIC_BASE_URL','https://example.com'],
    ['GEMINI_STATE_ENCRYPTION_KEY','bad'],
    ['GEMINI_API_KEY',''],
    ['POSTGRES_APP_PASSWORD',valid().POSTGRES_PASSWORD],
    ['ANCFZ_PAYMENT_DISPATCH_ENABLED','true'],
  ]) {
    const result = assessConfiguration({...valid(),[name]:value},'chat');
    assert.equal(result.ready,false, name);
  }
});
test('knowledge scope fails without approved directories and model, not falsely ready', () => {
  const r = assessConfiguration({...valid(),GEMINI_FILE_SEARCH_MODEL:''},'knowledge');
  assert.equal(r.ready,false);
  assert(r.checks.some(x=>x.name==='file_search_model_identifier'&&x.status==='fail'));
});
test('workflow execution is opt-in and separately credential-bound', () => {
  const r = assessConfiguration(valid(),'workflow');
  assert.equal(r.ready,false);
  assert(r.checks.some(x=>x.name==='private_n8n_encryption_key'&&x.status==='fail'));
});
test('payment scope blocks missing sandbox OTP approval and document extraction', () => {
  const r = assessConfiguration({...valid(), ANCFZ_PAYMENT_DISPATCH_ENABLED:'true'},'payment');
  assert.equal(r.ready,false);
  assert(r.checks.some(x=>x.name==='sandbox_payment_opt_in'&&x.status==='fail'));
  assert(r.checks.some(x=>x.name==='sandbox_document_extraction'&&x.status==='fail'));
});
test('no keys or credentials appear in serialized readiness checks', () => {
  const v = valid();
  const output = JSON.stringify(assessConfiguration(v,'chat'));
  for(const secret of ['GEMINI_API_KEY','POSTGRES_PASSWORD','POSTGRES_APP_PASSWORD',
    'GEMINI_STATE_ENCRYPTION_KEY']) {
    assert(!output.includes(v[secret]));
  }
});
