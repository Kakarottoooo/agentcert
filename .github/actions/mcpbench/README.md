# MCPBench GitHub Action

This local composite action runs the offline MCPBench eval path and writes:

- `events.jsonl`
- `results.json`
- `report.md`
- `badge.svg`

Example:

```yaml
- uses: ./.github/actions/mcpbench
  with:
    suite: basic-tool-use
    script: passing
    output-dir: .mcpbench/run
```

