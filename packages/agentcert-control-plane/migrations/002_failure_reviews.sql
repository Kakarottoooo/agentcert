CREATE TABLE IF NOT EXISTS agentcert_failure_reviews (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES agentcert_runs(id) ON DELETE CASCADE,
  pattern_key TEXT NOT NULL,
  suggested_type TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'corrected')),
  reviewer_id UUID NOT NULL,
  reviewer TEXT NOT NULL,
  note TEXT,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  taxonomy_rationale JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, pattern_key)
);

CREATE INDEX IF NOT EXISTS agentcert_failure_reviews_project_idx
  ON agentcert_failure_reviews(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_failure_reviews_run_idx
  ON agentcert_failure_reviews(run_id, updated_at DESC);

ALTER TABLE agentcert_failure_reviews ENABLE ROW LEVEL SECURITY;
