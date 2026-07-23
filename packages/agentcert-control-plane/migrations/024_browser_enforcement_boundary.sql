CREATE TABLE IF NOT EXISTS agentcert_runtime_identities (
  runtime_identity_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED','COMPROMISED','EXPIRED')),
  identity JSONB NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, key_id)
);

CREATE TABLE IF NOT EXISTS agentcert_execution_grants (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  runtime_identity_id UUID NOT NULL REFERENCES agentcert_runtime_identities(runtime_identity_id),
  grant_record JSONB NOT NULL,
  grant_digest_sha256 TEXT NOT NULL CHECK (grant_digest_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('ISSUED','CLAIMED','CONSUMED','EXPIRED','REVOKED','ABANDONED','FAILED')),
  execution_session_id UUID,
  claim_idempotency_key TEXT,
  claimed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, action_id),
  UNIQUE (project_id, grant_digest_sha256),
  UNIQUE (project_id, claim_idempotency_key)
);

CREATE TABLE IF NOT EXISTS agentcert_browser_enforcement_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  execution_grant_id UUID NOT NULL UNIQUE REFERENCES agentcert_execution_grants(id) ON DELETE RESTRICT,
  runtime_identity_id UUID NOT NULL REFERENCES agentcert_runtime_identities(runtime_identity_id),
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','EXECUTING','COMPLETED','FAILED','ABANDONED')),
  session_record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_runtime_identities_project_status_idx ON agentcert_runtime_identities(project_id, status);
CREATE INDEX IF NOT EXISTS agentcert_execution_grants_project_action_idx ON agentcert_execution_grants(project_id, action_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_execution_grants_runtime_status_idx ON agentcert_execution_grants(runtime_identity_id, status, expires_at);
CREATE INDEX IF NOT EXISTS agentcert_execution_grants_expiry_idx ON agentcert_execution_grants(status, expires_at);
CREATE INDEX IF NOT EXISTS agentcert_browser_sessions_project_action_idx ON agentcert_browser_enforcement_sessions(project_id, action_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_browser_sessions_runtime_status_idx ON agentcert_browser_enforcement_sessions(runtime_identity_id, status, updated_at DESC);

ALTER TABLE agentcert_runtime_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_execution_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_browser_enforcement_sessions ENABLE ROW LEVEL SECURITY;
