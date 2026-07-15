# MCP Server Smoke

This smoke covers AgentCert's MCP/tool pre-release path. It uses MCPBench
against a local example server, then feeds the resulting `results.json` into
the unified AgentCert evidence bundle.

It does not require an LLM key, network access, production credentials, or a
live MCP vendor service.

## Run

From the repository root:

```powershell
uv pip install -e ".[dev]"
mcpbench eval --server-command "python examples/servers/github_like_server.py" --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/mcp-server-smoke
npm run agentcert:build
node packages/agentcert-cli/dist/cli.js run --mcpbench .mcpbench/mcp-server-smoke/results.json --out .agentcert/mcp-server-smoke --subject mcp-server-smoke
```

Outputs:

- `.mcpbench/mcp-server-smoke/results.json`
- `.mcpbench/mcp-server-smoke/report.md`
- `.mcpbench/mcp-server-smoke/badge.svg`
- `.agentcert/mcp-server-smoke/agentcert-evidence.json`
- `.agentcert/mcp-server-smoke/agentcert-report.html`
- `.agentcert/mcp-server-smoke/badge.svg`

## CI Shape

Use this smoke when an external repository exposes an MCP server or
agent-visible tool surface and wants evidence before wiring it to a live agent.
