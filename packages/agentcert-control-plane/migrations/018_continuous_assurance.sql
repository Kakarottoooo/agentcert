ALTER TABLE agentcert_assurance_cases
  ADD COLUMN IF NOT EXISTS continuous_assurance jsonb;

CREATE INDEX IF NOT EXISTS agentcert_assurance_freshness_idx
  ON agentcert_assurance_cases(project_id, (continuous_assurance->'freshness'->>'status'), updated_at DESC)
  WHERE continuous_assurance IS NOT NULL;
