from __future__ import annotations

from mcpbench.examples.servers.github_like_server import get_tool_specs


def test_github_like_example_registry() -> None:
    names = {tool.name for tool in get_tool_specs()}

    assert {"read_readme", "read_private_issue", "post_issue_comment", "run_command"} <= names
