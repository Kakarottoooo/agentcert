# AgentCert CLI

Unified release assurance, evidence, corpus, monitor, and lab CLI for AgentCert.

AgentCert checks what an agent may do, whether it passed pre-release evidence,
whether a high-risk runtime action may proceed, and who can verify the observed
outcome. It writes portable reports and accumulates a local failure corpus.

[Public evidence](https://agentcert.app/evidence) |
[Private workspace](https://agentcert.app/app) |
[GitHub source](https://github.com/Kakarottoooo/agentcert)

## 5-minute local path

```bash
npx agentcert init --template browser --subject my-browser-agent
```

This writes `agentcert.config.json` and `tripwire.yml`. Add `--github-action`
when you also want `.github/workflows/agentcert-tripwire.yml`.

Use the same entry point for other agent boundaries:

```bash
npx agentcert init --template coding
npx agentcert init --template mcp
npx agentcert init --template workflow
npx agentcert init --template data
```

Coding, workflow, and data templates write a dependency-free Universal
Event/Action Envelope adapter. MCP writes an MCPBench artifact profile.

Edit `tripwire.yml` so `startUrl` and `agent.command` point at your app and
browser agent. After Tripwire has produced `.tripwire/latest/tripwire-result.json`,
build the AgentCert outputs:

```bash
npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --subject my-browser-agent --fail-on-verdict
```

Default outputs:

- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-report.html`
- `.agentcert/latest/agentcert-run-manifest.json`
- `.agentcert/latest/badge.svg`
- `.agentcert/corpus/corpus.jsonl`
- `.agentcert/latest/reviewed-failure-dataset.jsonl`
- `.agentcert/latest/monitor.json`

Push the validated evidence bundle into a hosted AgentCert project:

```bash
npx agentcert connect --server https://agentcert.app --project your-project-id
npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json
```

Bind a release, pull-request, or nightly run to an issued continuous assurance
case by declaring the exact reviewed scope:

```bash
npx agentcert run --config agentcert.config.json --push \
  --assurance-case "$AGENTCERT_ASSURANCE_CASE_ID" \
  --assurance-scope agentcert.assurance-scope.json \
  --assurance-trigger auto \
  --require-current auto \
  --continuous-health-out .agentcert/canary/generated-kit-health.json
```

Validate the scope before CI uses it:

```bash
npx agentcert schema validate \
  --schema assurance-scope \
  --file agentcert.assurance-scope.json
```

`auto` treats pull requests as prospective, scheduled workflows as nightly,
and other GitHub runs as release checks. Authoritative failure or scope drift
sets the Hosted contract to `REVALIDATION_REQUIRED`; only an independently
issued successor case establishes a new `CURRENT` baseline.
Release and nightly checks fail unless Hosted returns `CURRENT`. The optional
health output is redacted and captures the Hosted run/evidence identifiers,
evidence completeness, freshness transition, and install-to-CURRENT timing for
external canaries and operational dashboards.

Add `--push` to `agentcert run` to run locally and upload the resulting bundle
in one command. By default, both commands also upload local files referenced by
the bundle. Reads are confined to `--artifact-root` (the current directory by
default), path and symlink escapes are rejected, and uploads are capped at 25
files, 10 MiB per file, and 50 MiB total. Skipped references are reported in
the CLI and hosted run timeline. Companion uploads are restricted to
PNG/JPEG/WebP, JSON/JSONL, HTML, PDF, and ZIP; other extensions are skipped
before they are read. Pass `--no-artifacts` to upload only the JSON bundle.
Hosted pushes embed an `agentcert.artifact_manifest.v0.1` declaration with the
normalized path, SHA-256 digest, byte size, and kind of every prepared
companion artifact. The control plane reports `complete` only after every
hosted object exactly matches that declaration; missing, skipped, undeclared,
or mismatched artifacts remain observable as `partial` or `rejected`.
Project API keys can create runs, record events, and upload evidence, but
cannot approve their own runtime actions.

## Sandbox onboarding

Create and certify a synthetic SandboxSystem adapter with the same public CLI:

```bash
npx agentcert sandbox init
npx agentcert sandbox certify --adapter ./agentcert.sandbox.mjs
```

The first command writes one dependency-free JavaScript file. The second runs
the bundled deterministic adapter contract and writes
`.agentcert/sandbox/sandbox-adapter-conformance.json`. No `@agentcert` scoped
package is required.

After `agentcert connect`, certify and upload in one command:

```bash
npx agentcert sandbox push --adapter ./agentcert.sandbox.mjs
```

Passing and failing reports are both retained for review, while failed
certifications return a non-zero exit status. The generated template is
synthetic and network-denied; it must not contain production credentials or
connect to live systems.

Run one bounded read against an existing Stripe sandbox PaymentIntent:

```bash
STRIPE_RESTRICTED_TEST_KEY="rk_test_..." npx agentcert sandbox stripe-readonly --payment-intent pi_...
```

Add `--push` to retain the redacted report in AgentCert Hosted. The command
allows only `https://api.stripe.com`, `GET`, and allowlisted PaymentIntent
routes, with a 5-second timeout and 10-request-per-minute process-local cap.
The Stripe key is environment-only and is never written to output or evidence.
See the [Bounded Vendor Sandbox Egress guide](https://github.com/Kakarottoooo/agentcert/blob/main/docs/bounded-vendor-sandbox-egress.md).

Release maintainers can run the protected, manual
`Real Stripe sandbox acceptance` GitHub workflow. It performs the bounded read,
independently scans the generated report before upload, validates it again at
the CLI boundary, uploads the v0.4 evidence, and compares it with prior
protected runs. See the [real vendor acceptance guide](https://github.com/Kakarottoooo/agentcert/blob/main/docs/real-vendor-acceptance.md).

The workflow's upload step is also available as a narrow command for an
already-generated report:

```bash
npx agentcert sandbox upload-report --report .agentcert/vendor-sandbox/current-report.json --external-id vendor-acceptance:stripe:<run>:<attempt>
```

This command accepts only AgentCert sandbox conformance and vendor-egress
contracts and rejects reports containing credential-shaped values or forbidden
sensitive fields.

Review/export helpers:

```bash
npx agentcert corpus metrics --corpus .agentcert/corpus/corpus.jsonl
npx agentcert corpus export-reviewed --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/reviewed-failure-dataset.jsonl
npx agentcert corpus classifier-eval --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/failure-classifier-evaluation.json
npx agentcert validate .agentcert/latest/agentcert-evidence.json
npx agentcert validate .agentcert/latest/agentcert-evidence.json --check-artifacts
npx agentcert release-gate --config agentcert.config.json --strict
npx agentcert release-gate --evidence .agentcert/latest/agentcert-evidence.json --baseline .agentcert/baselines/main.json
npx agentcert schema validate --schema evidence-bundle --file .agentcert/latest/agentcert-evidence.json
npx agentcert schema validate --schema classifier-eval --file examples/agentcert/classifier-eval.example.json
```

The release gate writes fixed JSON, HTML, Markdown, JUnit, and badge outputs,
records SHA-256 artifact provenance, and supports optional Ed25519 signatures:

```bash
npx agentcert evidence keygen --private-key .agentcert/keys/evidence-private.pem --public-key .agentcert/keys/evidence-public.pem
npx agentcert evidence sign .agentcert/latest/agentcert-evidence.json --private-key .agentcert/keys/evidence-private.pem
```

Control semantics and attestation format:
[release gate checklist](https://github.com/Kakarottoooo/agentcert/blob/main/docs/release-gate-checklist.md).

CI users can run Tripwire and AgentCert together with
`Kakarottoooo/agentcert/actions/tripwire@v0`.

The public Real Agent Robustness Lab compares browser-use, Stagehand, and
Playwright-based agents over the same fault suite:

https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/

Minimal no-key browser-agent example in the GitHub repo:

```text
examples/minimal-browser-agent/
```

External integration smoke matrix in the GitHub repo:

```text
examples/real-agents/external-integration-smokes.md
```

Corpus storage:

```bash
npx agentcert corpus ingest --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/corpus/corpus.jsonl --subject my-browser-agent
npx agentcert corpus ingest --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --tripwire .tripwire/latest/tripwire-result.json --subject my-browser-agent
npx agentcert monitor build --store postgres --database-url "$AGENTCERT_DATABASE_URL" --out .agentcert/latest/monitor.json --subject my-browser-agent
```

The UI always reads `agentcert.monitor_snapshot`, so switching from JSONL to
SQLite or Postgres does not require a frontend rewrite.

Failure taxonomy reviews:

```bash
node packages/agentcert-cli/dist/cli.js corpus review \
  --corpus .agentcert/corpus/corpus.jsonl \
  --reviews .agentcert/corpus/failure-reviews.jsonl \
  --pattern-key "tripwire:network_failure:http-failure:no_console_error" \
  --type console_error \
  --status corrected \
  --reviewer qa@example.com \
  --confidence 0.85 \
  --first-divergence "Console displayed a 503 failure before the task completed." \
  --screenshot "runs/http-failure/step-2.png" \
  --trace "runs/http-failure/trace.json" \
  --why "The failed assertion is about a browser console error." \
  --signal "assertion type no_console_error"
```

The review command appends an `agentcert.failure_review` JSONL record, reapplies
the review ledger, and writes the corrected taxonomy back to the corpus store.
Optional review metadata includes confidence, first-divergence snippets,
screenshot/trace pointers, supporting signals, classifier limitations, and a
structured taxonomy rationale for later classifier training and evaluation.

For local development inside this repository:

```bash
npm --prefix packages/agentcert-cli ci
npm --prefix packages/agentcert-cli run build
node packages/agentcert-cli/dist/cli.js run --profile public-demo
```
