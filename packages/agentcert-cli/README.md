# AgentCert CLI

Unified evidence, corpus, monitor, and lab CLI for AgentCert.

AgentCert is regression CI for browser agents. It runs Tripwire robustness
checks, converts the result into evidence bundles, writes HTML reports and
badges, and accumulates a local failure corpus.

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

Review/export helpers:

```bash
npx agentcert corpus metrics --corpus .agentcert/corpus/corpus.jsonl
npx agentcert corpus export-reviewed --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/reviewed-failure-dataset.jsonl
npx agentcert corpus classifier-eval --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/latest/failure-classifier-evaluation.json
npx agentcert validate .agentcert/latest/agentcert-evidence.json
npx agentcert validate .agentcert/latest/agentcert-evidence.json --check-artifacts
npx agentcert schema validate --schema evidence-bundle --file .agentcert/latest/agentcert-evidence.json
npx agentcert schema validate --schema classifier-eval --file examples/agentcert/classifier-eval.example.json
```

Release gate checklist:

```text
docs/release-gate-checklist.md
```

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
