"""JSON report renderer."""

from __future__ import annotations

from mcpbench.models import RunResult


def render_json_report(result: RunResult) -> str:
    return result.model_dump_json(indent=2)
