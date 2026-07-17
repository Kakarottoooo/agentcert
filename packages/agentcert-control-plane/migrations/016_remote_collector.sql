CREATE TABLE IF NOT EXISTS agentcert_collector_source_keys (
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  public_key_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','retired','revoked')),
  previous_key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (project_id,key_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agentcert_collector_source_keys_active_idx
  ON agentcert_collector_source_keys(project_id,collector_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS agentcert_trusted_collector_runs (
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  source_key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','completed','degraded','reconciled')),
  first_sequence BIGINT NOT NULL,
  last_sequence BIGINT NOT NULL,
  first_event_hash TEXT NOT NULL,
  last_event_hash TEXT NOT NULL,
  accepted_event_count BIGINT NOT NULL,
  dropped_event_count BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  source_receipt JSONB,
  reconciliation JSONB,
  server_attestation JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id,run_id)
);
CREATE INDEX IF NOT EXISTS agentcert_trusted_collector_runs_project_idx
  ON agentcert_trusted_collector_runs(project_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS agentcert_trusted_collector_records (
  project_id UUID NOT NULL,
  run_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  record_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  source_key_id TEXT NOT NULL,
  record JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id,run_id,sequence),
  UNIQUE (project_id,run_id,record_id),
  UNIQUE (project_id,run_id,event_hash),
  FOREIGN KEY (project_id,run_id) REFERENCES agentcert_trusted_collector_runs(project_id,run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agentcert_collector_heartbeats (
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  source_key_id TEXT NOT NULL,
  run_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  pending_record_count BIGINT NOT NULL,
  last_ack_sequence BIGINT,
  status TEXT NOT NULL CHECK (status IN ('healthy','backlogged')),
  PRIMARY KEY (project_id,collector_id)
);

CREATE TABLE IF NOT EXISTS agentcert_trusted_collector_alerts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  collector_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('events_dropped','undeclared_gap','chain_conflict','heartbeat_stale')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS agentcert_trusted_collector_alerts_project_idx
  ON agentcert_trusted_collector_alerts(project_id,created_at DESC);

ALTER TABLE agentcert_collector_source_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_trusted_collector_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_trusted_collector_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_collector_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_trusted_collector_alerts ENABLE ROW LEVEL SECURITY;
