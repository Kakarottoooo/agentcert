CREATE TABLE IF NOT EXISTS agentcert_legal_hold_requests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('requested','approved','rejected','released')),
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  requested_by_email text,
  requested_at timestamptz NOT NULL,
  reviewed_by uuid,
  reviewed_by_email text,
  review_note text,
  reviewed_at timestamptz,
  released_by uuid,
  released_by_email text,
  release_note text,
  released_at timestamptz
);

ALTER TABLE agentcert_legal_hold_requests ADD COLUMN IF NOT EXISTS released_by uuid;
ALTER TABLE agentcert_legal_hold_requests ADD COLUMN IF NOT EXISTS released_by_email text;
ALTER TABLE agentcert_legal_hold_requests ADD COLUMN IF NOT EXISTS release_note text;

CREATE INDEX IF NOT EXISTS agentcert_legal_holds_project_idx
  ON agentcert_legal_hold_requests(project_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS agentcert_legal_holds_status_idx
  ON agentcert_legal_hold_requests(status, requested_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS agentcert_legal_holds_one_active_idx
  ON agentcert_legal_hold_requests(project_id)
  WHERE status IN ('requested','approved');

ALTER TABLE agentcert_legal_hold_requests ENABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS agentcert_evidence_linked_digest_idx;
CREATE UNIQUE INDEX IF NOT EXISTS agentcert_evidence_linked_digest_path_idx
  ON agentcert_evidence(
    project_id,
    COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(action_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    sha256,
    COALESCE(metadata->>'sourcePath', '')
  )
  WHERE run_id IS NOT NULL OR action_id IS NOT NULL;
