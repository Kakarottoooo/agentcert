ALTER TABLE agentcert_actions
  ADD COLUMN IF NOT EXISTS assurance_context JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS agentcert_actions_mandate_idx
  ON agentcert_actions(project_id, ((assurance_context->>'mandateId')))
  WHERE assurance_context ? 'mandateId';
