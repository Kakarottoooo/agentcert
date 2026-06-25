# AgentCert CLI

Unified evidence, corpus, monitor, and lab CLI for AgentCert.

After the package is published, the intended low-friction entrypoint is:

```bash
npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/latest --subject my-agent --fail-on-verdict
```

Core outputs:

- `agentcert-evidence.json`
- `agentcert-report.md`
- `agentcert-run-manifest.json`
- `badge.svg`
- optional corpus and monitor snapshots

Failure taxonomy reviews:

```bash
node packages/agentcert-cli/dist/cli.js corpus review \
  --corpus .agentcert/corpus/corpus.jsonl \
  --reviews .agentcert/corpus/failure-reviews.jsonl \
  --pattern-key "tripwire:network_failure:http-failure:no_console_error" \
  --type console_error \
  --status corrected \
  --reviewer qa@example.com
```

The review command appends an `agentcert.failure_review` JSONL record, reapplies
the review ledger, and writes the corrected taxonomy back to the corpus store.

For local development inside this repository:

```bash
npm --prefix packages/agentcert-cli ci
npm --prefix packages/agentcert-cli run build
node packages/agentcert-cli/dist/cli.js run --profile public-demo
```
