ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS consecutive_passes integer NOT NULL DEFAULT 0;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS last_passed_at timestamptz;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS acknowledged_by uuid;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS acknowledged_by_email text;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS resolved_by_email text;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS github_issue_number integer;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS github_issue_url text;
ALTER TABLE agentcert_incidents ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE agentcert_incidents SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL;
ALTER TABLE agentcert_incidents ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE agentcert_incidents ALTER COLUMN updated_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS agentcert_incidents_active_fingerprint_idx
  ON agentcert_incidents(project_id,fingerprint)
  WHERE fingerprint IS NOT NULL AND status <> 'resolved';

CREATE TABLE IF NOT EXISTS agentcert_incident_transitions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES agentcert_incidents(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('open','investigating','recovered','resolved')),
  actor_type text NOT NULL CHECK (actor_type IN ('system','user','api_key')),
  actor_id text,
  actor_email text,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agentcert_incident_transitions_incident_idx
  ON agentcert_incident_transitions(incident_id,occurred_at ASC);

CREATE TABLE IF NOT EXISTS agentcert_notification_destinations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  alert_types text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_verification','active','disabled')),
  verification_token_hash text,
  verification_expires_at timestamptz,
  verified_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  UNIQUE(project_id,email)
);

CREATE TABLE IF NOT EXISTS agentcert_notification_deliveries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES agentcert_notification_destinations(id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered','failed')),
  provider text NOT NULL,
  provider_message_id text,
  error text,
  attempted_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agentcert_notification_deliveries_project_idx
  ON agentcert_notification_deliveries(project_id,attempted_at DESC);

ALTER TABLE agentcert_incident_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_notification_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_notification_deliveries ENABLE ROW LEVEL SECURITY;
