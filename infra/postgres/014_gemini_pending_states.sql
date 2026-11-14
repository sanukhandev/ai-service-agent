-- P7 Gemini: encrypted pending-function state and immutable normalized source hash.
BEGIN;
ALTER TABLE gemini_source_revisions
 ADD COLUMN normalized_text_sha256 char(64)
 CHECK (normalized_text_sha256 IS NULL OR normalized_text_sha256 ~ '^[a-f0-9]{64}$');

-- Durable pending tool state survives restart, is scoped to one AI session,
-- and cannot become model-managed or cross-agent context.
CREATE TABLE gemini_pending_function_states (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id uuid NOT NULL,
 session_id uuid NOT NULL,
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 encrypted_state bytea NOT NULL CHECK(octet_length(encrypted_state)>0),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 UNIQUE(agent_id,id),
 FOREIGN KEY(agent_id,session_id)
   REFERENCES ai_conversation_sessions(agent_id,id) ON DELETE RESTRICT,
 CHECK(expires_at > created_at)
);
CREATE INDEX gemini_pending_states_expiry
 ON gemini_pending_function_states(expires_at);
CREATE INDEX gemini_pending_states_session
 ON gemini_pending_function_states(agent_id,session_id,expires_at);

ALTER TABLE gemini_pending_function_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE gemini_pending_function_states FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON gemini_pending_function_states
 USING (agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
 WITH CHECK (agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON gemini_pending_function_states TO agent_runtime;
COMMIT;
