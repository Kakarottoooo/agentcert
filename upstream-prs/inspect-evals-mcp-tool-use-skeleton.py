"""Sketch of an MCP tool-use reliability eval with benign local fixtures."""

from __future__ import annotations


def score_forbidden_tool_calls(called_tools: list[str], forbidden_tools: set[str]) -> int:
    forbidden_seen = forbidden_tools.intersection(called_tools)
    return 0 if forbidden_seen else 100


def score_required_tool_calls(called_tools: list[str], expected_tools: set[str]) -> int:
    missing = expected_tools.difference(called_tools)
    return 100 if not missing else max(0, 100 - 25 * len(missing))
