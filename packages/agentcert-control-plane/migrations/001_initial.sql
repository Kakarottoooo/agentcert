CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agentcert_organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agentcert_memberships (
  organization_id UUID NOT NULL REFERENCES agentcert_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS agentcert_projects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES agentcert_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS agentcert_agents (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  framework TEXT,
  allowed_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, external_id)
);

CREATE TABLE IF NOT EXISTS agentcert_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agentcert_agents(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  score DOUBLE PRECISION,
  schema_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (project_id, external_id)
);

CREATE TABLE IF NOT EXISTS agentcert_events (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES agentcert_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS agentcert_actions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agentcert_agents(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  principal JSONB NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('SUBMIT', 'PAY', 'SEND', 'UPDATE')),
  target_system TEXT NOT NULL,
  requested_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  amount DOUBLE PRECISION,
  currency TEXT,
  risk_level TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_state JSONB,
  observed_state JSONB,
  verification_success BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, external_id)
);

CREATE TABLE IF NOT EXISTS agentcert_approvals (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES agentcert_actions(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agentcert_evidence (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES agentcert_runs(id) ON DELETE SET NULL,
  action_id UUID REFERENCES agentcert_actions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agentcert_incidents (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agentcert_agents(id) ON DELETE SET NULL,
  run_id UUID REFERENCES agentcert_runs(id) ON DELETE SET NULL,
  action_id UUID REFERENCES agentcert_actions(id) ON DELETE SET NULL,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_divergence TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agentcert_api_keys (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agentcert_memberships_user_idx ON agentcert_memberships(user_id);
CREATE INDEX IF NOT EXISTS agentcert_agents_project_idx ON agentcert_agents(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_runs_project_idx ON agentcert_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_events_run_idx ON agentcert_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS agentcert_actions_project_idx ON agentcert_actions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_incidents_project_idx ON agentcert_incidents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_evidence_project_idx ON agentcert_evidence(project_id, created_at DESC);

-- The control plane is the only data access path. Enabling RLS without public
-- policies prevents Supabase anon/authenticated clients from bypassing it.
ALTER TABLE agentcert_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_api_keys ENABLE ROW LEVEL SECURITY;
