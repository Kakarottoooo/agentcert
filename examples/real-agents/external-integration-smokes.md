# External Integration Smokes

This matrix tracks the five external integration paths AgentCert uses to find
real adoption friction. The goal is not to claim broad agent safety. The goal
is to make setup, config, evidence, CI, and README friction visible.

| Integration | Upstream | Path | Key required | Status |
|---|---|---|---|---|
| browser-use | https://github.com/browser-use/browser-use | `examples/real-agents/browser-use/` | yes | wired adapter; live runs require caller model key |
| Stagehand | https://github.com/browserbase/stagehand | `examples/real-agents/stagehand/` | yes | wired adapter; live runs require caller model key |
| Playwright agent | https://github.com/microsoft/playwright | `examples/real-agents/playwright-agent/` | no | deterministic public baseline checked into Lab |
| LangGraph browser/tool agent | https://github.com/langchain-ai/langgraph | `examples/real-agents/langgraph/` | no | optional smoke adapter using LangGraph plus Playwright CDP |
| MCP server/tool smoke | https://github.com/modelcontextprotocol | `examples/real-agents/mcp-server-smoke/` | no | offline MCPBench smoke feeding AgentCert evidence |

## What Each Smoke Checks

- Can a fresh user install the needed dependencies?
- Is the Tripwire or MCPBench config understandable?
- Does the adapter use local deterministic fixtures instead of production
  systems?
- Does CI produce JUnit, HTML, evidence JSON, badge, corpus, reviewed dataset,
  and monitor snapshot?
- If the run fails, does the evidence explain the first useful divergence?

## Run Order

Start with deterministic smokes:

```powershell
npm run tripwire:lab-playwright-agent
npm run agentcert:build
node packages/agentcert-cli/dist/cli.js run --mcpbench public-demo/lifecycle-evidence/mcpbench-passing/results.json --out .agentcert/mcp-smoke --subject mcp-server-smoke
```

Then run optional real public-agent smokes when a model key is available:

```powershell
npm run tripwire:lab-browser-use
npm run tripwire:lab-stagehand
```

LangGraph is optional and deterministic, but it has its own Python dependency
environment:

```powershell
python -m venv .venv-langgraph
.\\.venv-langgraph\\Scripts\\python -m pip install -r examples/real-agents/langgraph/requirements.txt
npm run tripwire:lab-langgraph
```

Do not check in private API keys, production credentials, or live customer
artifacts.
