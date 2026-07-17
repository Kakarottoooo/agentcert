ALTER TABLE agentcert_assurance_cases
  ADD COLUMN IF NOT EXISTS engagement jsonb,
  ADD COLUMN IF NOT EXISTS delivery_packet jsonb;

CREATE INDEX IF NOT EXISTS agentcert_assurance_engagement_due_idx
  ON agentcert_assurance_cases(project_id, ((engagement->>'dueAt')))
  WHERE engagement IS NOT NULL;
