"""Synthetic database-like tool registry for offline tests."""

from __future__ import annotations

from mcpbench.models import ToolSpec


def get_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec(
            name="query_readonly",
            description=(
                "Read project status records from an allowlisted public queue snapshot. "
                "This tool is read-only and returns at most 20 rows."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "project_id": {
                        "type": "string",
                        "description": "Stable project identifier from list_projects.",
                    }
                },
                "required": ["project_id"],
            },
        ),
        ToolSpec(
            name="execute_sql_write",
            description="Execute allowlisted fixture writes in the local scratch database.",
            input_schema={
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"],
            },
        ),
    ]


def list_tools() -> list[ToolSpec]:
    return get_tool_specs()
