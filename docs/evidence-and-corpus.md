# Evidence Layer, Corpus, and Monitor Operations

This page holds the full command reference for AgentCert's evidence bundle,
corpus data flywheel, failure-review ledger, and monitor. The README keeps the
5-minute Tripwire path; everything deeper lives here.

## Unified Evidence Runner

Run the full local evidence pipeline against the checked-in public demo
artifacts:

```powershell
npm --prefix packages/agentcert-cli ci
npm run agentcert:run-public
```

For your own project, pass artifact paths directly:

```powershell
node packages/agentcert-cli/dist/cli.js run `
  --mcpbench .mcpbench/latest/results.json `
  --tripwire .tripwire/latest/tripwire-result.json `
  --onegent .onegent/procurement/audit-packet.json `
  --out .agentcert/latest `
  --corpus .agentcert/corpus/corpus.jsonl `
  --monitor-out .agentcert/latest/monitor.json `
  --reviewed-dataset-out .agentcert/latest/reviewed-failure-dataset.jsonl `
  --replace `
  --fail-on-verdict
```

Use `--fail-on-verdict` in CI when a failed AgentCert verdict should block the
workflow. The public demo profile intentionally leaves that off because its
Tripwire slice contains expected adversarial failures.

Generate a unified evidence bundle from existing engine artifacts:

```powershell
npm --prefix packages/agentcert-cli ci
npm --prefix packages/agentcert-cli run build
node packages/agentcert-cli/dist/cli.js report --mcpbench examples/reports/passing/results.json --out .agentcert/latest --subject demo-agent
```

Outputs:

- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-report.html`

The unified bundle is the review artifact AgentCert is built around. It can
include MCPBench results, Tripwire CI results, and Onegent Runtime audit
packets.

## Corpus Storage

Build a local corpus from evidence artifacts:

```powershell
node packages/agentcert-cli/dist/cli.js corpus ingest --mcpbench public-demo/lifecycle-evidence/mcpbench-passing/results.json --tripwire public-demo/browser-agent-robustness/evidence/tripwire-public-demo/tripwire-result.json --onegent public-demo/lifecycle-evidence/onegent-procurement/audit-packet.json --out .agentcert/corpus/corpus.jsonl --subject demo-agent --replace
node packages/agentcert-cli/dist/cli.js corpus summary --corpus .agentcert/corpus/corpus.jsonl
```

JSONL is the default corpus storage because it is easy to diff and commit for
public demos. For accumulated local or hosted runs, the same CLI can write to
SQLite or Postgres without changing the dashboard contract:

```powershell
node packages/agentcert-cli/dist/cli.js corpus ingest --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --tripwire packages/tripwire-ci/.tripwire/public-demo/tripwire-result.json --subject demo-agent --replace
node packages/agentcert-cli/dist/cli.js corpus summary --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite
node packages/agentcert-cli/dist/cli.js monitor build --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --out packages/agentcert-dashboard/public/data/monitor.json --subject demo-agent
```

SQLite storage uses Node's built-in `node:sqlite`, so use Node 22+ for that
store. JSONL remains the Node 20-compatible default.

Postgres uses the optional `pg` driver and a caller-provided database URL:

```powershell
$env:AGENTCERT_DATABASE_URL="postgres://user:password@localhost:5432/agentcert"
node packages/agentcert-cli/dist/cli.js corpus ingest --store postgres --tripwire packages/tripwire-ci/.tripwire/public-demo/tripwire-result.json --subject demo-agent
node packages/agentcert-cli/dist/cli.js monitor build --store postgres --out packages/agentcert-dashboard/public/data/monitor.json --subject demo-agent
```

The frontend does not connect to SQLite or Postgres directly. It reads the
generated `monitor.json` snapshot, so the UI stays the same whether the corpus
came from JSONL, SQLite, or Postgres.

## Failure Taxonomy and Review Ledger

Corpus records include `agentName`, `agentVersion`, and an AgentCert failure
taxonomy so repeated runs become a data flywheel instead of one-off demo
output. Current failure buckets include `prompt_injection`, `wrong_click`,
`timeout`, `verification_gap`, `silent_partial_success`, `network_failure`,
`ui_drift`, `policy_or_approval`, `agent_connection`, `console_error`,
`assertion_failure`, and `unknown_failure`.

Human review can confirm or correct those automatic labels. Reviews are stored
in a small JSONL ledger and reapplied when corpus data or monitor snapshots are
rebuilt:

```powershell
node packages/agentcert-cli/dist/cli.js corpus review `
  --corpus .agentcert/corpus/corpus.jsonl `
  --reviews .agentcert/corpus/failure-reviews.jsonl `
  --pattern-key "tripwire:network_failure:http-failure:no_console_error" `
  --type console_error `
  --status corrected `
  --reviewer qa@example.com `
  --confidence 0.85 `
  --first-divergence "Console displayed a 503 failure before the task completed." `
  --screenshot "runs/http-failure/step-2.png" `
  --trace "runs/http-failure/trace.json" `
  --why "The failed assertion is about a browser console error, not the HTTP fault itself." `
  --signal "assertion type no_console_error" `
  --classifier-limitation "The automatic rule started from the fault name before assertion semantics." `
  --note "Console assertion failed; this should train the corpus as console_error."
```

The dashboard shows `suggestedType`, effective `type`, and review status for
each failure pattern. In static GitHub Pages mode it displays a copyable review
command. In local server mode, `npm run agentcert:serve` enables UI write-back
to the corpus store and failure-review ledger.

Reviewed labels can also carry reviewer confidence, the first observed
divergence, screenshot/trace pointers, supporting signals, and a structured
rationale. That turns the review ledger into a higher-quality failure dataset
for future automatic taxonomy classifiers instead of a rules-only label
override file.

Export the reviewed dataset and taxonomy quality metrics:

```powershell
node packages/agentcert-cli/dist/cli.js corpus metrics --corpus .agentcert/corpus/corpus.jsonl
node packages/agentcert-cli/dist/cli.js corpus export-reviewed --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/reviewed-failure-dataset.jsonl
node packages/agentcert-cli/dist/cli.js corpus classifier-eval --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/failure-classifier-evaluation.json
```

`agentcert run` writes a reviewed-failure dataset automatically. The monitor
shows review coverage, reviewed-label precision, correction rate, and filters
for agent, fault, version, failure type, and review status.

## Monitor Snapshot and Local Console

Build the monitor snapshot and UI:

```powershell
npm run agentcert:monitor-build
```

That script calls `agentcert run --profile public-demo` before building the
dashboard, so the checked-in public monitor is regenerated from the same
unified runner path users can run locally.

Run the local evidence console:

```powershell
npm run agentcert:serve
```

Open `http://127.0.0.1:8765`. The local server keeps the same dashboard UI but
adds API-backed inspection:

- `GET /api/monitor` returns the current monitor snapshot from the selected corpus store.
- `GET /api/corpus/metrics` returns taxonomy coverage, reviewed-label precision, and correction rate.
- `GET /api/corpus/reviewed-dataset` exports reviewed failure rows as JSONL.
- `GET /api/runs` returns accumulated run records.
- `GET /api/runs/:id` returns assertion failures, trace timeline, diagnostics, warnings, and linked artifacts.
- `POST /api/runs/:id/failure-reviews` writes a human taxonomy review, reapplies the review ledger, and updates the corpus store.
- `GET /api/artifacts?path=...` serves screenshots, DOM snapshots, trace JSON, and related files from the configured artifact root.

## Public Monitor

Canonical public demo:

[https://agentcert-control-plane.onrender.com/demo](https://agentcert-control-plane.onrender.com/demo)

Immutable GitHub Pages archive:

[https://kakarottoooo.github.io/agentcert/public-demo/agentcert-monitor/](https://kakarottoooo.github.io/agentcert/public-demo/agentcert-monitor/)

The monitor reads a generated `monitor.json` snapshot from the AgentCert corpus
and shows lifecycle gate status, accumulated corpus record counts and pass
rate, filters, top failure patterns, and recent evidence runs. The public demo
is intentionally read-only. Use `/app` for authenticated hosted operations or
`npm run agentcert:serve` for local corpus write-back.

The checked-in public corpus currently contains 11 records: 1 MCPBench passing
pre-release run, 9 Tripwire CI browser-agent scenario runs, and 1 Onegent
Runtime procurement approval and audit run.

Checked-in demo evidence:

- `public-demo/lifecycle-evidence/mcpbench-passing/`
- `public-demo/browser-agent-robustness/evidence/tripwire-public-demo/`
- `public-demo/lifecycle-evidence/onegent-procurement/`
- `public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl`
- `public-demo/browser-agent-robustness/evidence/failure-reviews.jsonl`
- `public-demo/browser-agent-robustness/evidence/agentcert-public-demo/`

Regenerate the public fixture:

```powershell
npm --prefix packages/tripwire-ci run build
npm run tripwire:demo-public
npm run agentcert:monitor-build
```

## Evidence Schema

The AgentCert evidence bundle is versioned as `agentcert.evidence_bundle`
schema family `1`, semver `1.0.0`. The schema defines required
bundle/result/evidence fields, optional metadata, corpus fields, monitor
snapshot fields, and the failure taxonomy used by the data flywheel.

Validate evidence artifacts locally:

```powershell
node packages/agentcert-cli/dist/cli.js schema validate --schema evidence-bundle --file examples/agentcert/evidence-bundle.example.json
node packages/agentcert-cli/dist/cli.js schema validate --schema monitor-snapshot --file public-demo/agentcert-monitor/data/monitor.json
```

Read the schema guide: [standards/evidence-schema.md](standards/evidence-schema.md)
