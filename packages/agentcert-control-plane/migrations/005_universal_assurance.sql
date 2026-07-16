ALTER TABLE agentcert_runs ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE agentcert_runs ADD COLUMN IF NOT EXISTS root_span_id text;
ALTER TABLE agentcert_events ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE agentcert_events ADD COLUMN IF NOT EXISTS span_id text;
ALTER TABLE agentcert_events ADD COLUMN IF NOT EXISTS parent_span_id text;
ALTER TABLE agentcert_actions ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE agentcert_actions ADD COLUMN IF NOT EXISTS span_id text;
ALTER TABLE agentcert_actions ADD COLUMN IF NOT EXISTS parent_span_id text;
ALTER TABLE agentcert_api_keys ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT
  '["agents:read","runs:read","runs:write","events:write","actions:read","actions:write","evidence:read","evidence:write"]'::jsonb;

CREATE INDEX IF NOT EXISTS agentcert_runs_trace_idx ON agentcert_runs(project_id, trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agentcert_events_trace_idx ON agentcert_events(project_id, trace_id, span_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agentcert_actions_trace_idx ON agentcert_actions(project_id, trace_id) WHERE trace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agentcert_evidence_deletions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL,
  run_id uuid,
  action_id uuid,
  object_key text NOT NULL,
  file_name text NOT NULL,
  kind text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('deleted','held','missing','failed')),
  reason text NOT NULL,
  error text,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_evidence_deletions_project_idx
  ON agentcert_evidence_deletions(project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS agentcert_idempotency (
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, key, operation)
);

CREATE INDEX IF NOT EXISTS agentcert_idempotency_expiry_idx ON agentcert_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS agentcert_webhooks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  event_types jsonb NOT NULL,
  secret_ciphertext text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS agentcert_webhook_deliveries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES agentcert_webhooks(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered','failed')),
  response_status integer,
  error text,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_webhooks_project_idx ON agentcert_webhooks(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_webhook_deliveries_project_idx ON agentcert_webhook_deliveries(project_id, attempted_at DESC);

ALTER TABLE agentcert_evidence_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_webhook_deliveries ENABLE ROW LEVEL SECURITY;
