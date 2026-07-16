CREATE INDEX IF NOT EXISTS agentcert_projects_created_at_idx
  ON agentcert_projects(created_at DESC);

CREATE INDEX IF NOT EXISTS agentcert_api_keys_project_created_idx
  ON agentcert_api_keys(project_id, created_at ASC);

CREATE INDEX IF NOT EXISTS agentcert_api_keys_project_used_idx
  ON agentcert_api_keys(project_id, last_used_at ASC)
  WHERE last_used_at IS NOT NULL;
