from __future__ import annotations

from mcpbench.examples.servers.duckdb_like_server import get_tool_specs
from mcpbench.introspection.inspector import inspect_tools


def test_duckdb_like_example_registry() -> None:
    result = inspect_tools(get_tool_specs())

    assert result["summary"]["tool_count"] == 2
    assert any(tool["name"] == "query_readonly" for tool in result["tools"])
