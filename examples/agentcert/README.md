# AgentCert Unified Evidence Example

This example shows the intended evidence flow with the unified runner:

```powershell
npm run agentcert:build
node packages/agentcert-cli/dist/cli.js run --config examples/agentcert/agentcert.config.json --skip-commands
```

The command reads configured evidence artifacts and writes:

```text
.agentcert/latest/agentcert-evidence.json
.agentcert/latest/agentcert-report.md
.agentcert/latest/agentcert-run-manifest.json
.agentcert/corpus/corpus.jsonl
.agentcert/monitor/monitor.json
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
  --monitor-out .agentcert/monitor/monitor.json `
  --subject my-agent `
  --replace `
  --fail-on-verdict
```
