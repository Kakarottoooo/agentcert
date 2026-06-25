"""Tool registry inspection."""

from __future__ import annotations

from typing import Any

from mcpbench.introspection.permissions import estimate_blast_radius
from mcpbench.introspection.risk_classifier import classify_tool_spec
from mcpbench.introspection.schema_lint import lint_tool_schema
from mcpbench.models import ToolSpec


def inspect_tools(
    tools: list[ToolSpec],
    *,
    overrides: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    inspected = [classify_tool_spec(tool, overrides=overrides) for tool in tools]
    return {
        "tools": [
            {
                **tool.model_dump(mode="json"),
                "blast_radius": estimate_blast_radius(tool),
                "lint_warnings": [
                    warning.model_dump(mode="json") for warning in lint_tool_schema(tool)
                ],
            }
            for tool in inspected
        ],
        "summary": {
            "tool_count": len(inspected),
            "high_blast_radius_tools": sorted(
                tool.name for tool in inspected if "high_blast_radius" in tool.risk_classes
            ),
            "external_sinks": sorted(
                tool.name for tool in inspected if "external_sink" in tool.risk_classes
            ),
        },
    }
