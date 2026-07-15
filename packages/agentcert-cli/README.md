# AgentCert CLI

Unified release assurance, evidence, corpus, monitor, and lab CLI for AgentCert.

AgentCert checks what an agent may do, whether it passed pre-release evidence,
whether a high-risk runtime action may proceed, and who can verify the observed
outcome. It writes portable reports and accumulates a local failure corpus.

## 5-minute local path

```bash
npx agentcert init --subject my-browser-agent
```

This writes `agentcert.config.json` and `tripwire.yml`. Add `--github-action`
when you also want `.github/workflows/agentcert-tripwire.yml`.

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
npx agentcert connect --server https://agentcert-control-plane.onrender.com --project your-project-id
npx agentcert push --evidence .agentcert/latest/agentcert-evidence.json
```

Add `--push` to `agentcert run` to run locally and upload the resulting bundle
in one command. By default, both commands also upload local files referenced by
the bundle. Reads are confined to `--artifact-root` (the current directory by
default), path and symlink escapes are rejected, and uploads are capped at 25
files, 10 MiB per file, and 50 MiB total. Skipped references are reported in
the CLI and hosted run timeline. Companion uploads are restricted to
PNG/JPEG/WebP, JSON/JSONL, HTML, PDF, and ZIP; other extensions are skipped
before they are read. Pass `--no-artifacts` to upload only the JSON bundle.
Project API keys can create runs, record events, and upload evidence, but
cannot approve their own runtime actions.

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
