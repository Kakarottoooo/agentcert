# Hosted Control Plane

AgentCert's public GitHub Pages monitor is a static evidence demonstration. The
hosted control plane is the authenticated operational surface for organizations,
projects, agents, runs, runtime actions, incidents, and private evidence.

## Recommended Production Profile

- **Render Web Service:** one Docker deployment serves the React console and
  Node API on the same origin.
- **Supabase Postgres:** production system of record.
- **Supabase Auth:** open email/password registration and email verification.
- **Supabase Storage:** private `agentcert-evidence` bucket for screenshots,
  DOM, traces, reports, and evidence bundles.

This keeps the initial production footprint to two vendors. The application
code still uses ordinary Postgres and an `ArtifactStore` interface, so another
Postgres or S3-compatible provider can replace Supabase later.

## Security Boundaries

- Supabase secret credentials are server-only.
- Browser sessions use the publishable key and a short-lived user access token.
- Agent/CI API keys are scoped to one project and stored only as SHA-256 hashes.
- API key metadata can be listed and active keys can be revoked by owners or
  admins; internal key hashes are never returned by the API.
- Agent credentials cannot approve or reject actions.
- Agent credentials cannot register identities or grant permissions; only a
  human owner or admin can change that authorization boundary.
- Production refuses to start without Postgres and Supabase configuration.
- Development authentication refuses to listen on non-loopback interfaces and
  cannot run with `NODE_ENV=production`.
- Evidence downloads are authenticated and proxied by the control plane.
- Artifact uploads are bounded by `AGENTCERT_MAX_ARTIFACT_BYTES`.
- Every application table has Postgres row-level security enabled with no
  client policy. Supabase Data API clients cannot bypass the control plane.
- API responses include `x-request-id`; Render receives structured JSON access
  and error logs containing method, path, status, and duration, never request
  bodies or authorization headers.

## Local Development

```powershell
npm --prefix packages/agentcert-dashboard run build
npm --prefix packages/agentcert-control-plane install
npm --prefix packages/agentcert-control-plane run build
$env:AGENTCERT_DEV_MODE="true"
$env:HOST="127.0.0.1"
$env:PORT="8787"
$env:AGENTCERT_DASHBOARD_DIR="../../public-demo/agentcert-monitor"
npm --prefix packages/agentcert-control-plane start
```

Open `http://127.0.0.1:8787`. Development mode uses an in-memory database,
loopback-only auth, and local artifact files.

## Production Environment

Required:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=10000
AGENTCERT_PUBLIC_URL=https://app.your-domain.com
DATABASE_URL=postgresql://...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
AGENTCERT_STORAGE_BUCKET=agentcert-evidence
AGENTCERT_DASHBOARD_DIR=/app/public-demo/agentcert-monitor
AGENTCERT_MAX_ARTIFACT_BYTES=20971520
```

Never expose `DATABASE_URL` or `SUPABASE_SECRET_KEY` to the browser,
GitHub Pages, source control, or a client-side build variable.

## Deployment Walkthrough

### 1. Create Supabase

1. Sign in at `https://supabase.com/dashboard` and choose **New project**.
2. Select the region closest to the Render region you will use.
3. Save the generated database password in a password manager.
4. Open **SQL Editor**, paste
   `packages/agentcert-control-plane/migrations/001_initial.sql`, and run it.
5. Click **Connect**, choose **Session pooler**, and copy the port `5432`
   connection string. Use this value as `DATABASE_URL`; session mode is the
   appropriate choice for a persistent Render service on an IPv4 network.

### 2. Configure Authentication

1. Open **Authentication -> Sign In / Providers -> Email**.
2. Enable **Allow new users to sign up**.
3. Keep **Confirm Email** enabled for production.
4. Open **Authentication -> URL Configuration**.
5. Initially set **Site URL** to the Render URL, for example
   `https://agentcert-control-plane.onrender.com`.
6. Add the same exact URL under **Redirect URLs**. Replace both with the custom
   domain after DNS is verified.
7. Before public launch, configure **Authentication -> Emails -> SMTP
   Settings** with Resend, Postmark, SES, or another production SMTP provider.
   Supabase's built-in mail service is restricted and is not a production
   delivery system for arbitrary public signups.

### 3. Create Private Object Storage

1. Open **Storage** and select **New bucket**.
2. Name it `agentcert-evidence`.
3. Keep **Public bucket** disabled. Private is the default.
4. Set the bucket file-size limit to at least `20 MB`, or lower
   `AGENTCERT_MAX_ARTIFACT_BYTES` to match.
5. Do not add public read policies. The AgentCert server writes with the
   secret key and proxies authenticated downloads.

### 4. Copy Supabase Credentials

From **Project Settings -> API Keys**, record:

- Project URL -> `SUPABASE_URL`
- publishable key (`sb_publishable_...`) -> `SUPABASE_PUBLISHABLE_KEY`
- secret key (`sb_secret_...`) -> `SUPABASE_SECRET_KEY`

The publishable key is intentionally returned by `/v1/config` for browser auth.
The secret key must exist only in Render. Existing deployments may continue to
use `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` as compatibility
fallbacks, but new deployments should use the current key types above.

### 5. Deploy on Render

1. Sign in at `https://dashboard.render.com` with GitHub.
2. Choose **New -> Blueprint**.
3. Select the `Kakarottoooo/agentcert` repository. Render reads the root
   `render.yaml` and `Dockerfile.control-plane`.
4. Enter all `sync: false` values when prompted:
   `AGENTCERT_PUBLIC_URL`, `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`.
5. Set `AGENTCERT_PUBLIC_URL` to the initial `https://...onrender.com` URL.
6. Deploy and wait for `/health` to return `{ "ok": true }`.
7. Open the service URL, create an account, confirm the email, and verify that
   the first organization/project is created.

### 6. Add a Custom Domain

1. In Render, open the web service and choose **Settings -> Custom Domains ->
   Add Custom Domain**.
2. Use a subdomain such as `app.agentcert.dev`; keeping the marketing/docs site
   separate avoids future routing conflicts.
3. Render shows the exact DNS record. In your domain registrar, add that CNAME
   record and wait for Render to verify TLS.
4. Change `AGENTCERT_PUBLIC_URL` in Render to
   `https://app.agentcert.dev` and redeploy.
5. In Supabase **Authentication -> URL Configuration**, change **Site URL** to
   the same address and add it as an exact **Redirect URL**.
6. Create a fresh test account using an email address outside your Supabase
   organization to verify public registration and SMTP delivery.

### 7. First External Agent

1. Sign in to AgentCert, open **Agents**, and register the agent with the exact
   permissions it is allowed to request.
2. Open **Integrations**, select **Create API key**, and copy the secret
   immediately; only its hash is retained.
3. Run the project-specific `agentcert connect` command shown in
   **Integrations**. For CI, set `AGENTCERT_BASE_URL`,
   `AGENTCERT_PROJECT_ID`, and `AGENTCERT_API_KEY` in the secret manager.
4. Start one run, append events, complete the run, and confirm it appears in
   **Runs**.
5. Open the run, inspect its ordered events and evidence bundle, then confirm or
   correct one failure label. Human reviews retain confidence, first divergence,
   artifact pointers, supporting signals, and the reviewer's identity. Project
   API keys can read analysis but cannot write human reviews.
6. Propose a high-risk action and confirm that the Agent credential cannot
   approve it, while a human reviewer can approve it in **Runtime actions**.
7. Revoke the test key in **Integrations** and confirm subsequent requests with
   that key return `401`.

The hosted console is the canonical operational UI. The checked-in static
monitor remains a deterministic public demo and compatibility view; new
interactive evidence analysis and review workflows belong in the hosted run
workspace rather than a second stateful frontend.

Existing CLI users can publish without adopting an SDK:

```bash
npx agentcert connect --server https://app.agentcert.dev --project your-project-id
npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json
```

The CLI automatically uploads local companion artifacts referenced by the
bundle. It only reads files under `--artifact-root` (default: the current
directory), rejects path and symlink escapes, and enforces fixed limits of 25
files, 10 MiB per file, and 50 MiB per push. The run timeline records uploaded
and skipped counts plus bounded skip reasons. `--no-artifacts` preserves the
bundle-only behavior for restricted environments.

## Open Registration

The console displays **Create account** whenever `/v1/config` reports Supabase
auth. Supabase controls whether registration and email confirmation are enabled.
On first confirmed sign-in, `POST /v1/onboarding/bootstrap` creates an isolated
organization, owner membership, and first project.

## External Agent Interfaces

- REST: [openapi/control-plane-v1.yaml](openapi/control-plane-v1.yaml)
- TypeScript: `packages/agentcert-sdk`
- Python: `packages/agentcert-sdk-python`
- MCP stdio adapter: `packages/agentcert-mcp-adapter`

The machine path is intentionally separate from the human dashboard. Agents
submit intent, runs, events, observed state, and evidence through the API; they
do not scrape or operate the dashboard.
