CREATE UNIQUE INDEX IF NOT EXISTS agentcert_projects_org_slug_unique
  ON agentcert_projects(organization_id, slug);

CREATE TABLE IF NOT EXISTS agentcert_pilot_feedback (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('project','api_key','cli_connect','first_run','evidence_upload','dashboard_review')),
  category TEXT NOT NULL CHECK (category IN ('install','authentication','configuration','execution','evidence','dashboard','other')),
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked','confusing','failed','completed','suggestion')),
  reason_code TEXT NOT NULL,
  message TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_pilot_feedback_project_created_idx
  ON agentcert_pilot_feedback(project_id, created_at DESC);

ALTER TABLE agentcert_pilot_feedback ENABLE ROW LEVEL SECURITY;
