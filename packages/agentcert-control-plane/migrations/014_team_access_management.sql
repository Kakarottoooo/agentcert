ALTER TABLE agentcert_memberships DROP CONSTRAINT IF EXISTS agentcert_memberships_role_check;
UPDATE agentcert_memberships SET role='operator' WHERE role='reviewer';
ALTER TABLE agentcert_memberships ADD CONSTRAINT agentcert_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'operator', 'viewer'));
ALTER TABLE agentcert_memberships ADD COLUMN IF NOT EXISTS email TEXT;

CREATE TABLE IF NOT EXISTS agentcert_project_memberships (
  project_id UUID NOT NULL REFERENCES agentcert_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  granted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

INSERT INTO agentcert_project_memberships(project_id,user_id,created_at)
SELECT p.id,m.user_id,COALESCE(m.created_at,now())
FROM agentcert_memberships m
JOIN agentcert_projects p ON p.organization_id=m.organization_id
WHERE m.role IN ('operator','viewer')
ON CONFLICT (project_id,user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agentcert_team_invitations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES agentcert_organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending','sent','failed')),
  delivery_error TEXT,
  invited_by UUID NOT NULL,
  invited_by_email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  accepted_by UUID,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agentcert_team_invitations_pending_email_idx
  ON agentcert_team_invitations(organization_id,lower(email)) WHERE status='pending';
CREATE INDEX IF NOT EXISTS agentcert_project_memberships_user_idx ON agentcert_project_memberships(user_id);

CREATE TABLE IF NOT EXISTS agentcert_team_audit (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES agentcert_organizations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID NOT NULL,
  actor_email TEXT,
  target_user_id UUID,
  target_email TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agentcert_team_audit_org_idx ON agentcert_team_audit(organization_id,occurred_at DESC);

ALTER TABLE agentcert_project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_team_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentcert_team_audit ENABLE ROW LEVEL SECURITY;
