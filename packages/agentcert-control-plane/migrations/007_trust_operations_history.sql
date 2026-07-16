CREATE TABLE IF NOT EXISTS agentcert_trust_health_samples (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('production_smoke','manual')),
  status text NOT NULL CHECK (status IN ('passed','failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  workflow_run_id text,
  workflow_run_url text,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, external_id)
);

CREATE INDEX IF NOT EXISTS agentcert_trust_health_samples_project_idx
  ON agentcert_trust_health_samples(project_id, completed_at DESC);

ALTER TABLE agentcert_trust_health_samples ENABLE ROW LEVEL SECURITY;
