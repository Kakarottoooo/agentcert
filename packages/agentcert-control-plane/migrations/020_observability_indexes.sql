CREATE INDEX IF NOT EXISTS agentcert_events_project_occurred_idx
  ON agentcert_events(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS agentcert_events_project_type_occurred_idx
  ON agentcert_events(project_id, type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS agentcert_actions_project_trace_idx
  ON agentcert_actions(project_id, trace_id, created_at)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agentcert_actions_project_risk_created_idx
  ON agentcert_actions(project_id, risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS agentcert_approvals_project_created_idx
  ON agentcert_approvals(project_id, created_at DESC);
