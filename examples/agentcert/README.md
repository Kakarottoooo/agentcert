# AgentCert Unified Evidence Example

This example shows the intended evidence flow with the unified runner:

```powershell
npm run agentcert:build
node packages/agentcert-cli/dist/cli.js run --config examples/agentcert/agentcert.config.json --skip-commands
node packages/agentcert-cli/dist/cli.js release-gate --config examples/agentcert/agentcert.config.json --skip-commands
```

The command reads configured evidence artifacts and writes:

```text
.agentcert/latest/agentcert-evidence.json
.agentcert/latest/agentcert-report.md
.agentcert/latest/agentcert-report.html
.agentcert/latest/agentcert-run-manifest.json
.agentcert/corpus/corpus.jsonl
.agentcert/latest/reviewed-failure-dataset.jsonl
.agentcert/latest/monitor.json
.agentcert/latest/agentcert-release-gate.json
.agentcert/latest/agentcert-release-gate.html
.agentcert/latest/agentcert-release-gate-junit.xml
.agentcert/latest/release-gate-badge.svg
```

Schema examples in this directory:

- `evidence-bundle.example.json`
- `corpus-record.example.json`
- `failure-review.example.json`
- `classifier-eval.example.json`
- `monitor-snapshot.example.json`

Validate the evidence example:

```powershell
node packages/agentcert-cli/dist/cli.js validate examples/agentcert/evidence-bundle.example.json
node packages/agentcert-cli/dist/cli.js schema validate --schema release-gate --file .agentcert/latest/agentcert-release-gate.json
```

If an underlying engine exits non-zero after writing an evidence artifact, add
`"allowCommandFailure": true` to that job in `agentcert.config.json`. AgentCert
will still load the artifact and then apply the final unified verdict.

In a full project, pass all three artifact types:

```powershell
node packages/agentcert-cli/dist/cli.js run `
  --mcpbench .mcpbench/latest/results.json `
  --tripwire packages/tripwire-ci/.tripwire/latest/tripwire-result.json `
  --onegent packages/onegent-runtime/.onegent/procurement/audit-packet.json `
  --out .agentcert/latest `
  --corpus .agentcert/corpus/corpus.jsonl `
  --monitor-out .agentcert/latest/monitor.json `
  --reviewed-dataset-out .agentcert/latest/reviewed-failure-dataset.jsonl `
  --subject my-agent `
  --replace `
  --fail-on-verdict
```
