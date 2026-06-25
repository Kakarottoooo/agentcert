# GitHub Action

Use MCPBench in CI by installing the package and running the deterministic offline eval path.

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

