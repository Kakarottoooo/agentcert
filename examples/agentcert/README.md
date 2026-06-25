# AgentCert Unified Evidence Example

This example shows the intended evidence flow:

```powershell
npm run agentcert:report
```

The command reads an existing MCPBench result and writes:

```text
.agentcert/latest/agentcert-evidence.json
.agentcert/latest/agentcert-report.md
```

In a full project, pass all three artifact types:

```powershell
node packages/agentcert-cli/dist/cli.js report `
  --mcpbench .mcpbench/latest/results.json `
  --tripwire packages/tripwire-ci/.tripwire/latest/tripwire-result.json `
  --onegent packages/onegent-runtime/.onegent/procurement/audit-packet.json `
  --out .agentcert/latest `
  --subject my-agent
```
