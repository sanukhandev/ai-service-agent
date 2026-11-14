-- Generic authorized service-request action for every catalog operation
-- without a dedicated external provider integration.
-- Never claim an external action succeeded or queue an unconfigured webhook.
BEGIN;
CREATE TABLE ticket_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  action_key varchar(128) NOT NULL
    CHECK(action_key ~ '^[a-z][a-z0-9_]{0,127}$'),
  request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_staff_review'
    CHECK(status IN ('awaiting_staff_review','in_review','resolved','cancelled')),
  fact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(fact_snapshot)='object'),
  consent_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id,intent_id) REFERENCES intents(agent_id,id) ON DELETE RESTRICT,
  UNIQUE(agent_id,ticket_id,request_id),
  UNIQUE(agent_id,ticket_id,intent_id,action_key),
  UNIQUE(agent_id,ticket_id,id)
);
CREATE INDEX ticket_service_requests_status
  ON ticket_service_requests(agent_id,status,created_at DESC);
CREATE INDEX ticket_service_requests_by_ticket
  ON ticket_service_requests(agent_id,ticket_id,created_at DESC);
ALTER TABLE ticket_service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_service_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_service_requests_agent ON ticket_service_requests
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_service_requests TO agent_runtime;
COMMIT;
