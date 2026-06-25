# GitHub Actions

Use AgentCert in CI as a set of checkpoints plus one unified evidence packet.

## MCPBench Gate

```yaml
name: MCPBench

on:
  pull_request:

jobs:
  mcpbench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -e ".[dev]"
      - run: mcpbench eval --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/run
      - uses: actions/upload-artifact@v4
        with:
          name: mcpbench-report
          path: .mcpbench/run
```

Artifacts include `events.jsonl`, `results.json`, `report.md`, and `badge.svg`.

## Unified Evidence Packet

After one or more engines have produced artifacts, generate a portable
AgentCert evidence bundle:

```yaml
name: AgentCert Evidence

on:
  pull_request:

jobs:
  agentcert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: ./.github/actions/agentcert
        with:
          subject: my-agent
          subject-type: agent
          mcpbench: examples/reports/passing/results.json
          out: .agentcert/latest
      - uses: actions/upload-artifact@v4
        with:
          name: agentcert-evidence
          path: .agentcert/latest
```

Artifacts include:

- `agentcert-evidence.json`
- `agentcert-report.md`
