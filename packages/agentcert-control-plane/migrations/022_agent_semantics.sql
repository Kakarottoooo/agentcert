CREATE TABLE IF NOT EXISTS agentcert_capability_manifests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  manifest JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, manifest_id)
);

CREATE TABLE IF NOT EXISTS agentcert_capability_corrections (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  unknown_key TEXT NOT NULL,
  observed_name TEXT NOT NULL,
  framework TEXT,
  event_type TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reviewer_id TEXT NOT NULL,
  reviewer_email TEXT,
  source TEXT NOT NULL CHECK (source IN ('human','llm_confirmed')),
  classifier JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, unknown_key)
);

CREATE INDEX IF NOT EXISTS agentcert_capability_manifests_project_updated_idx
  ON agentcert_capability_manifests(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_capability_corrections_project_updated_idx
  ON agentcert_capability_corrections(project_id, updated_at DESC);

ALTER TABLE agentcert_capability_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_capability_corrections ENABLE ROW LEVEL SECURITY;
