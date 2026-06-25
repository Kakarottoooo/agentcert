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

## Tripwire + Unified Evidence Packet

Use this when the caller repository has a `tripwire.yml` that launches the
browser or computer-use agent under test. The action runs Tripwire, then writes
the AgentCert evidence bundle, corpus, reviewed failure dataset, monitor
snapshot, badge, manifest, and JUnit/HTML reports.

```yaml
name: AgentCert Tripwire

on:
  pull_request:
  push:
    branches: [main]

jobs:
  tripwire:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: Kakarottoooo/agentcert/actions/tripwire@v0
        with:
          config: tripwire.yml
          out: .tripwire/latest
          fail-under: "0.8"
          subject: my-browser-agent
          agentcert-out: .agentcert/latest
          fail-on-verdict: "true"
```

Artifacts include:

- `.tripwire/latest/tripwire-result.json`
- `.tripwire/latest/tripwire-report.html`
- `.tripwire/latest/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.html`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-run-manifest.json`
- `.agentcert/latest/badge.svg`
- `.agentcert/latest/corpus.jsonl`
- `.agentcert/latest/reviewed-failure-dataset.jsonl`
- `.agentcert/latest/monitor.json`
