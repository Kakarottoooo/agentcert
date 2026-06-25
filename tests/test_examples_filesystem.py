from __future__ import annotations

from mcpbench.examples.servers.filesystem_server import get_tool_specs
from mcpbench.introspection.inspector import inspect_tools


def test_filesystem_example_registry() -> None:
    result = inspect_tools(get_tool_specs())

    assert result["summary"]["tool_count"] == 2
    assert "write_file" not in result["summary"]["high_blast_radius_tools"]
