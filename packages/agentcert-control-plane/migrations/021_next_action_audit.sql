CREATE TABLE IF NOT EXISTS agentcert_next_action_decisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  schema_version text NOT NULL CHECK (schema_version = 'agentcert.next_action_decision.v0.3'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor jsonb NOT NULL,
  inputs jsonb NOT NULL,
  decision jsonb NOT NULL,
  previous_decision_id uuid REFERENCES agentcert_next_action_decisions(id) ON DELETE SET NULL,
  previous_fingerprint text CHECK (previous_fingerprint IS NULL OR previous_fingerprint ~ '^[0-9a-f]{64}$'),
  previous_decision jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_next_action_decisions_project_idx
  ON agentcert_next_action_decisions(project_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS agentcert_next_action_decisions_rule_idx
  ON agentcert_next_action_decisions(project_id, ((decision->>'rule')), occurred_at DESC);

ALTER TABLE agentcert_next_action_decisions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE agentcert_next_action_decisions IS
  'Append-only record of material project next-action transitions. Repeated evaluations with the same fingerprint are not inserted.';

COMMENT ON COLUMN agentcert_next_action_decisions.inputs IS
  'State summary captured when the recommendation changed; lower-priority changes do not alter the decision fingerprint.';
