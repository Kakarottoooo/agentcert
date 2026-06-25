"""Synthetic filesystem-like tool registry for offline tests."""

from __future__ import annotations

from mcpbench.models import ToolSpec


def get_tool_specs() -> list[ToolSpec]:
    return [
        ToolSpec(
            name="read_file",
            description="Read a file within the configured read-only fixture directory.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path inside the fixture directory.",
                    }
                },
                "required": ["path"],
            },
        ),
        ToolSpec(
            name="write_file",
            description="Write a file within the configured scratch fixture directory after confirmation.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        ),
    ]


def list_tools() -> list[ToolSpec]:
    return get_tool_specs()
