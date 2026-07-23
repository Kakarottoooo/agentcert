ALTER TABLE agentcert_approvals ADD COLUMN IF NOT EXISTS action_digest_sha256 TEXT;

CREATE TABLE IF NOT EXISTS agentcert_action_mandates (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  digest_sha256 TEXT NOT NULL CHECK (digest_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED','EXPIRED','SUPERSEDED','COMPROMISED','DISPUTED')),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  attestation JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  status_reason TEXT,
  status_changed_by TEXT,
  status_changed_at TIMESTAMPTZ,
  UNIQUE (project_id, digest_sha256)
);

CREATE TABLE IF NOT EXISTS agentcert_action_policy_decisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  action_digest_sha256 TEXT NOT NULL CHECK (action_digest_sha256 ~ '^[a-f0-9]{64}$'),
  decision JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agentcert_outcome_attestations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  action_digest_sha256 TEXT NOT NULL CHECK (action_digest_sha256 ~ '^[a-f0-9]{64}$'),
  attestation JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agentcert_action_assurance_receipts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  receipt JSONB NOT NULL,
  core_sha256 TEXT NOT NULL CHECK (core_sha256 ~ '^[a-f0-9]{64}$'),
  current_status TEXT NOT NULL CHECK (current_status IN ('ACTIVE','SUSPENDED','REVOKED','EXPIRED','SUPERSEDED','COMPROMISED','DISPUTED')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, core_sha256)
);

CREATE INDEX IF NOT EXISTS agentcert_action_mandates_project_idx ON agentcert_action_mandates(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_action_policy_decisions_action_idx ON agentcert_action_policy_decisions(project_id, action_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_outcome_attestations_action_idx ON agentcert_outcome_attestations(project_id, action_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_action_receipts_action_idx ON agentcert_action_assurance_receipts(project_id, action_id, created_at DESC);

ALTER TABLE agentcert_action_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_action_policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_outcome_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_action_assurance_receipts ENABLE ROW LEVEL SECURITY;
