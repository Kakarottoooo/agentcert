CREATE TABLE IF NOT EXISTS agentcert_notification_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES agentcert_notification_destinations(id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','retrying','delivered','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  provider text,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agentcert_notification_jobs_due_idx
  ON agentcert_notification_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending','retrying','processing');
CREATE INDEX IF NOT EXISTS agentcert_notification_jobs_project_idx
  ON agentcert_notification_jobs(project_id, created_at DESC);

ALTER TABLE agentcert_notification_deliveries ADD COLUMN IF NOT EXISTS job_id uuid
  REFERENCES agentcert_notification_jobs(id) ON DELETE SET NULL;
ALTER TABLE agentcert_notification_deliveries ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;

ALTER TABLE agentcert_notification_jobs ENABLE ROW LEVEL SECURITY;
