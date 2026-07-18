CREATE INDEX IF NOT EXISTS agentcert_assurance_expiry_maintenance_idx
  ON agentcert_assurance_cases(expires_at ASC)
  WHERE status = 'issued' AND continuous_assurance IS NOT NULL AND expires_at IS NOT NULL;
