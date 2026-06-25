# AgentCert CLI

Unified evidence, corpus, monitor, and lab CLI for AgentCert.

## 5-minute local path

```bash
npx agentcert init --subject my-browser-agent
```

Edit `tripwire.yml` so `startUrl` and `agent.command` point at your app and
browser agent. After Tripwire has produced `.tripwire/latest/tripwire-result.json`,
build the AgentCert outputs:

```bash
npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --subject my-browser-agent --fail-on-verdict
```

Default outputs:

- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-run-manifest.json`
- `.agentcert/latest/badge.svg`
- `.agentcert/corpus/corpus.jsonl`
- `.agentcert/monitor/monitor.json`

CI users can run Tripwire and AgentCert together with
`Kakarottoooo/agentcert/actions/tripwire@v0`.

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
