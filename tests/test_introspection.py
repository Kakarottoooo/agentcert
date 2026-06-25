from __future__ import annotations

from mcpbench.examples.servers.github_like_server import get_tool_specs
from mcpbench.introspection.inspector import inspect_tools


def test_inspect_tools_classifies_github_like_registry() -> None:
    result = inspect_tools(get_tool_specs())

    assert result["summary"]["tool_count"] == 4
    assert "run_command" in result["summary"]["high_blast_radius_tools"]
    assert "post_issue_comment" in result["summary"]["external_sinks"]
