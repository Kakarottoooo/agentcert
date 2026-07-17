# Hosted Control Plane

AgentCert Hosted is the canonical product entry point. `/` is the public product
site, `/evidence` is the anonymous assurance snapshot, and `/app` is the authenticated operational
surface for organizations, projects, agents, runs, runtime actions, incidents,
and private evidence. The legacy GitHub Pages monitor remains an immutable
public evidence archive and links visitors to `/evidence`. Existing `/demo`
links are preserved as a compatibility alias for `/evidence`.

## Recommended Production Profile

- **Render Web Service:** one Docker deployment serves the React console and
  Node API on the same origin.
- **Supabase Postgres:** production system of record.
- **Supabase Auth:** open email/password registration and email verification.
- **Supabase Storage:** private `agentcert-evidence` bucket for screenshots,
  DOM, traces, reports, and evidence bundles.
- **Redis-compatible key value:** shared rate limits and idempotency locks for
  multi-instance-safe request coordination. Postgres remains the durable queue.

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
- Individual HTTP uploads are bounded by `AGENTCERT_MAX_ARTIFACT_BYTES`.
- Stored evidence is additionally bounded per run and project. Quota checks
  are serialized in Postgres, so concurrent uploads cannot race past the cap.
- The server validates extension, MIME type, evidence kind, and file signature
  for PNG/JPEG/WebP, JSON/JSONL, HTML, PDF, and ZIP. Direct executable file
  signatures are rejected even when the file is renamed.
- Run analysis reports evidence as `complete`, `partial`, or `rejected`; this
  status is computed from server upload state and companion-artifact events,
  not accepted as a client assertion.
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

Open `http://127.0.0.1:8787/` for the product site,
`http://127.0.0.1:8787/evidence` for the public snapshot, or
`http://127.0.0.1:8787/app` for the workspace. Development mode uses an in-memory database,
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
AGENTCERT_PROJECT_STORAGE_BYTES=1073741824
AGENTCERT_RUN_STORAGE_BYTES=104857600
AGENTCERT_EVIDENCE_RETENTION_DAYS=90
AGENTCERT_EVIDENCE_CLEANUP_INTERVAL_MS=86400000
AGENTCERT_EVIDENCE_CLEANUP_BATCH=500
# Render Blueprint injects REDIS_URL from agentcert-coordination.
AGENTCERT_RATE_LIMIT_REQUESTS=300
AGENTCERT_RATE_LIMIT_WINDOW_MS=60000
AGENTCERT_WEBHOOK_WORKER_INTERVAL_MS=2000
AGENTCERT_WEBHOOK_WORKER_BATCH=20
AGENTCERT_NOTIFICATION_WORKER_INTERVAL_MS=5000
AGENTCERT_NOTIFICATION_WORKER_BATCH=20
# Optional platform-owned email delivery. Users never provide SMTP credentials.
RESEND_API_KEY=re_...
AGENTCERT_ALERT_FROM_EMAIL=AgentCert <alerts@your-verified-domain.com>
```

Never expose `DATABASE_URL` or `SUPABASE_SECRET_KEY` to the browser,
GitHub Pages, source control, or a client-side build variable.

## Deployment Walkthrough

### 1. Create Supabase

1. Sign in at `https://supabase.com/dashboard` and choose **New project**.
2. Select the region closest to the Render region you will use.
3. Save the generated database password in a password manager.
4. Open **SQL Editor** and run every numbered file in
   `packages/agentcert-control-plane/migrations/` in order. Existing deployments
   can run only newly added files; all migrations are idempotent.
5. Click **Connect**, choose **Session pooler**, and copy the port `5432`
   connection string. Use this value as `DATABASE_URL`; session mode is the
   appropriate choice for a persistent Render service on an IPv4 network.

### 2. Configure Authentication

1. Open **Authentication -> Sign In / Providers -> Email**.
2. Enable **Allow new users to sign up**.
3. Keep **Confirm Email** enabled for production.
4. Open **Authentication -> URL Configuration**.
5. Set **Site URL** to the canonical product URL: `https://agentcert.app`.
6. Add `https://agentcert.app` under **Redirect URLs**. Keep the generated
   Render service URL only as a temporary recovery redirect if needed.
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
5. The Blueprint creates the private `agentcert-coordination` Render Key Value
   service and injects its internal connection string as `REDIS_URL`; do not
   paste a hostname or a `redis-cli` command into the web service manually.
6. Set `AGENTCERT_PUBLIC_URL` to the initial `https://...onrender.com` URL.
7. Deploy and wait for `/health` to report
   `coordination.backend=redis`, `state=ready`, and `shared=true`.
8. Open the service URL, create an account, confirm the email, and verify that
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
monitor remains a deterministic public evidence snapshot and compatibility view; new
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

Before upload, the CLI adds an `agentcert.artifact_manifest.v0.1` declaration
containing each companion artifact's normalized path, SHA-256 digest, byte
size, and kind. The bundle is stored first. Every later companion upload is
checked against that stored declaration before object storage. Undeclared or
mismatched bytes return `422` and mark the run's latest evidence attempt as
rejected.

## Evidence Storage Governance

The production defaults are 1 GiB stored evidence per project, 100 MiB per
run, and 90-day retention. A quota violation returns `413`; an unsupported,
mislabeled, malformed, or executable artifact returns `415`. A rejected upload
does not leave object metadata behind, and run analysis exposes the rejection
reason rather than presenting existing artifacts as complete evidence.

The accepted server formats are PNG, JPEG, WebP, JSON, JSONL, HTML, PDF, and
ZIP. ZIP is accepted for browser traces and portable evidence archives, but
this release validates only its container signature; it does not inspect or
execute archive members. Non-image downloads, including HTML and ZIP, are
served as attachments.

The server runs bounded cleanup shortly after startup and then on the configured
interval. Cleanup deletes the private storage object through the provider API
before deleting its Postgres metadata. If object deletion fails, metadata is
retained so the record can be retried and audited. Operators can run the same
bounded task once during maintenance:

```bash
node packages/agentcert-control-plane/dist/cli.js cleanup-evidence
```

Storage quota, object count, and retention are visible on the project overview.
Each run shows evidence bytes, the earliest expiry date, and one of:

- `complete`: a v0.1 manifest is present and every declared path, SHA-256,
  byte size, and kind exactly matches the hosted object;
- `partial`: a bundle or referenced companion artifact is missing or skipped;
- `rejected`: the most recent upload attempt violated storage policy.

Older bundles without a manifest remain readable but are reported as
`partial` with legacy reconciliation status.

### Enterprise legal hold

Evidence is deleted after 90 days by default. Project owners and admins can
apply for a legal hold from the **Evidence** view or API. A `requested` hold
does not pause cleanup. Only a platform administrator listed in
`AGENTCERT_PLATFORM_ADMIN_EMAILS` can approve, reject, or release it, and the
requester cannot approve their own application. Approval represents an
operator decision that enterprise eligibility and preservation scope have
been verified outside the application.

```bash
# Project owner/admin
curl -X POST "$AGENTCERT_URL/v1/projects/$PROJECT_ID/legal-holds" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Preserve evidence for an active enterprise legal matter."}'

# Platform administrator
curl -X POST "$AGENTCERT_URL/v1/admin/legal-hold-requests/$REQUEST_ID/approve" \
  -H "Authorization: Bearer $PLATFORM_ADMIN_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reviewNote":"Enterprise eligibility and legal scope confirmed."}'
```

Approved holds exempt the whole project from scheduled evidence cleanup until
an administrator calls the corresponding `/release` endpoint. Releasing a
hold does not immediately delete data; it makes expired objects eligible for
the next bounded cleanup pass.

## Open Registration

The console displays **Create account** whenever `/v1/config` reports Supabase
auth. Supabase controls whether registration and email confirmation are enabled.
On first confirmed sign-in, `POST /v1/onboarding/bootstrap` creates an isolated
organization, owner membership, and clearly named assurance project.

## External Agent Interfaces

- REST: [openapi/control-plane-v1.yaml](openapi/control-plane-v1.yaml)
- TypeScript: `packages/agentcert-sdk`
- Python: `packages/agentcert-sdk-python`
- MCP stdio adapter: `packages/agentcert-mcp-adapter`

The machine path is intentionally separate from the human dashboard. Agents
submit intent, runs, events, observed state, and evidence through the API; they
do not scrape or operate the dashboard.

## Universal ingestion and API hardening

Framework adapters should prefer the
[Universal Event/Action Envelope](universal-envelope.md). Machine API keys are
project-scoped and carry explicit scopes. New keys can use the full ingestion
preset or a read-only preset; no API key can approve/reject actions, manage
agent permissions, or decide legal holds.

Machine run, event, action, envelope, completion, and verification routes
accept `Idempotency-Key`. The server stores the request
hash and response for 24 hours. Reusing the same key and body replays the
response; reusing it with a different body returns `409`. Authenticated traffic
is subject to a fixed-window limit and returns `429` plus `Retry-After` when
exhausted. When `REDIS_URL` is configured, limits and in-flight idempotency
locks are shared across instances. Without Redis the service stays available
with a single-process fallback and reports `coordination.state=degraded` from
`/health` and the project Trust Operations endpoint.

```text
AGENTCERT_RATE_LIMIT_REQUESTS=300
AGENTCERT_RATE_LIMIT_WINDOW_MS=60000
```

## Signed webhooks

Owners/admins can register HTTPS webhook endpoints for `run.completed`,
`action.approved`, `action.rejected`, `action.verified`, and
`evidence.accepted`. AgentCert signs `timestamp + "." + rawBody` with
HMAC-SHA-256 and sends:

```text
X-AgentCert-Event
X-AgentCert-Event-Id
X-AgentCert-Timestamp
X-AgentCert-Signature: v1=<hex digest>
```

Secrets are shown once and encrypted at rest with AES-256-GCM. Configure a
stable 32-byte base64url or 64-hex key:

```text
AGENTCERT_WEBHOOK_ENCRYPTION_KEY=<32 byte key>
```

Trust Operations v0.5 writes each webhook event and email notification to a
Postgres queue before returning to the caller. Workers claim jobs with leases and `FOR UPDATE SKIP LOCKED`, record
every delivery attempt, retry failed requests with bounded exponential backoff,
and move exhausted jobs to a dead-letter queue after five attempts. Expired
worker leases are reclaimable, so a process restart does not lose queued work.
The Dashboard shows pending, retrying, and dead-letter counts plus recent
failure details. It also persists scheduled production-smoke outcomes and shows
7-day smoke success, webhook latency, retry, and dead-letter trends. Redis,
server signing, scheduled smoke, webhook delivery, email delivery, and SLO burn
rate each expose a separate
operator-facing alert with a concrete reason. Delivery is at least once;
receivers must deduplicate using
`X-AgentCert-Event-Id`.

Production-smoke failures are deduplicated by project and fingerprint. The
incident lifecycle is `open -> investigating -> recovered -> resolved`.
Owners/admins acknowledge an open incident with a rationale. One passing smoke
records progress but does not recover it; two consecutive passing smokes append
recovery evidence. An owner/admin must then review that evidence and explicitly
resolve the incident.

The operations response includes 30- and 90-day 99% SLO attainment, remaining
error budget, and burn rate. It also evaluates paired 1h/6h fast-burn and
6h/24h sustained-burn windows. Fast burn requires at least three samples in
both windows and thresholds of 14.4x/6x. Sustained burn requires at least
three 6-hour and six 24-hour samples and thresholds of 6x/3x. These figures use
completed scheduled production smokes only. Missing or stale schedules remain
a separate alert, so absence of data cannot look healthy.

Owners/admins can add recipients in **Integrations -> Email alerts** and choose
opened, regressed, recovered, and resolved notifications. AgentCert sends a
24-hour ownership-verification link before activation. Provider credentials
remain platform-side; users configure only recipient addresses and alert types.
Delivery failures are retained in the notification attempt ledger, retried by
the background worker, and moved to a manually replayable DLQ after five
attempts. They never roll back an incident transition.

For production acceptance without a third-party endpoint, owners can open
**Integrations -> Trust operations** and select **Enable self-test receiver**.
AgentCert creates one `run.completed` webhook targeting its own public
receiver. The receiver accepts only a body with a valid five-minute timestamp,
matching event headers, and the exact HMAC signature over the received bytes.
It stores no duplicate payload; the durable job and attempt log remain the
audit record.

## Scheduled production acceptance

`.github/workflows/production-smoke.yml` runs daily and can also be dispatched
manually. It checks health and shared Redis coordination, idempotent replay and
conflict handling, evidence upload/download byte equality, historical-key
signature verification, run completion, signed webhook delivery through the
self-test receiver, and the Trust Operations status.

Each run persists a sanitized pass/fail health sample before the final status
check. A failed workflow creates one GitHub issue titled
`[AgentCert] Production trust smoke failure`; subsequent failures append to the
same open issue. A recovery comment is added only after two consecutive passing
smokes. The issue remains open until the AgentCert incident is explicitly
resolved; the next smoke reconciliation then closes it. Operators follow the
[Trust Operations incident runbook](trust-operations-runbook.md).

Configure these GitHub repository Actions secrets:

```text
AGENTCERT_PROJECT_ID=<production smoke project ID>
AGENTCERT_API_KEY=<project-scoped ingestion key>
```

The uploaded workflow artifact contains IDs and check results only. It never
contains the API key or authorization headers.

## Retention audit

Every cleanup attempt writes an immutable deletion-journal row containing the
evidence digest, object key, size, reason, outcome, timestamp, and failure text.
Platform administrators can review, approve, reject, and release legal holds in
the **Governance** view and export a project report containing policy, active
evidence, hold history, and the deletion journal.

The overview continuously exposes reviewed failure coverage, reviewed-label
precision, and correction rate under
`agentcert.failure_quality_metrics.v0.1`. New JSON evidence bundles record a
bounded failure-pattern count at ingestion; failed-run count is the fallback
for legacy bundles.

Platform administrators also receive 7/30/90-day pilot reports in the same
Governance view. `agentcert.pilot_funnel.v0.1` cohorts projects by creation
time, measures sequential project/key/CLI/evidence conversion, reports median
stage duration, and aggregates bounded onboarding-friction reasons. The JSON
export intentionally excludes API-key hashes, evidence bytes, user email, and
arbitrary feedback context.

Hosted evidence signing and verification are documented in
[Evidence Trust Chain v0.1](evidence-trust-chain.md).
