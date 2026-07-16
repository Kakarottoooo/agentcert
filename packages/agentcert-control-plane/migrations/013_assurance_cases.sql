CREATE TABLE IF NOT EXISTS agentcert_assurance_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','evaluating','review_required','issued','suspended','revoked','expired')),
  policy_pack_version text NOT NULL,
  evaluation_plan jsonb NOT NULL,
  evaluation_plan_sha256 text NOT NULL CHECK (evaluation_plan_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  reviewer_id text,
  report jsonb,
  public_verification_id text UNIQUE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS agentcert_assurance_case_decisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  assurance_case_id uuid NOT NULL REFERENCES agentcert_assurance_cases(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id text NOT NULL,
  actor_email text,
  reason text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_assurance_cases_project_idx ON agentcert_assurance_cases(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_assurance_decisions_case_idx ON agentcert_assurance_case_decisions(assurance_case_id, occurred_at ASC);

ALTER TABLE agentcert_assurance_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_assurance_case_decisions ENABLE ROW LEVEL SECURITY;
