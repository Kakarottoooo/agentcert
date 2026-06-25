# Contributing

MCPBench values reproducible behavior evidence over broad claims.

Good first contributions:

- Add deterministic JSONL traces for a new behavior-chain rule.
- Improve tool classification heuristics with tests.
- Add schema lint warnings with concrete maintainer guidance.
- Expand reports while keeping evidence linked to event ids.
- Improve upstream PR draft assets under `upstream-prs/`.

Development loop:

```powershell
uv pip install -e ".[dev]"
ruff format .
ruff check .
pytest
```

Default tests must not require API keys, external network access, production systems, or real secrets.

