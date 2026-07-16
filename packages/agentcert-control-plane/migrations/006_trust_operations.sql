CREATE TABLE IF NOT EXISTS agentcert_webhook_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES agentcert_webhooks(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','retrying','delivered','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  last_response_status integer,
  last_error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agentcert_webhook_jobs_due_idx
  ON agentcert_webhook_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending','retrying','processing');
CREATE INDEX IF NOT EXISTS agentcert_webhook_jobs_project_idx
  ON agentcert_webhook_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agentcert_signing_keys (
  key_id text PRIMARY KEY,
  algorithm text NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_pem text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','retired','revoked')),
  created_at timestamptz NOT NULL,
  activated_at timestamptz NOT NULL,
  retired_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS agentcert_signing_keys_one_active_idx
  ON agentcert_signing_keys(status) WHERE status = 'active';

ALTER TABLE agentcert_webhook_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_signing_keys ENABLE ROW LEVEL SECURITY;
