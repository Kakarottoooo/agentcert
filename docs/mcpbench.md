# MCPBench

MCPBench is AgentCert's pre-release benchmark engine for MCP servers and
agent-exposed tools. It answers: are this server's tools safe, observable,
reliable, and explainable enough to expose to agents?

MCPBench runs fully offline by default. It does not require OpenAI, Anthropic,
local model, network, or production credentials.

## Quickstart

```powershell
uv pip install -e ".[dev]"
mcpbench doctor
```

Run a passing MCP/tool eval:

```powershell
mcpbench eval --server-command "python examples/servers/github_like_server.py" --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/passing
```

Run a failing behavior-chain eval:

```powershell
mcpbench eval --server-command "python examples/servers/github_like_server.py" --suite untrusted-output --agent scripted --script failing-untrusted-to-sink --output-dir .mcpbench/failing
```

Outputs:

- `events.jsonl`
- `results.json`
- `report.md`
- `badge.svg`

## What Feedback Looks Like

```text
MCPBench: 35/100
AgentCert: Not certified
Critical violations: 1
High violations: 1
Key finding: sensitive synthetic canary reached a public/external sink.
```

## CI Usage

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: "3.11"
- run: pip install -e ".[dev]"
- run: mcpbench eval --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/run
```

## Feeding MCPBench Results Into AgentCert Evidence

MCPBench `results.json` files are one of the inputs the unified AgentCert CLI
accepts:

```powershell
node packages/agentcert-cli/dist/cli.js run --mcpbench .mcpbench/latest/results.json --out .agentcert/latest --subject my-mcp-server
```

## Development Checks

```powershell
ruff format --check .
ruff check .
mypy src/mcpbench
pytest
```

## Related Docs

- [eval-spec.md](eval-spec.md)
- [policy-spec.md](policy-spec.md)
- [scoring.md](scoring.md)
- [runtime-monitoring.md](runtime-monitoring.md)
