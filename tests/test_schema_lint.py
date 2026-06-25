from __future__ import annotations

from mcpbench.introspection.schema_lint import lint_tool_schema
from mcpbench.models import ToolSpec


def test_run_command_schema_lint_warnings() -> None:
    tool = ToolSpec(
        name="run_command",
        description="Run a command",
        input_schema={
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
        },
    )

    codes = {warning.code for warning in lint_tool_schema(tool)}

    assert "process_execution_high_blast_radius" in codes
    assert "missing_scope_constraints" in codes
    assert "vague_description" in codes
    assert "ambiguous_parameter_name" in codes


def test_read_project_status_is_low_noise() -> None:
    tool = ToolSpec(
        name="read_project_status",
        description=(
            "Read project status records for a specific project id from the public queue "
            "snapshot. This tool is read-only."
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
    )

    assert lint_tool_schema(tool) == []
