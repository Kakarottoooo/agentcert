"""Conservative example: map an MCP-style tool call to trace attributes."""

from __future__ import annotations

from hashlib import sha256
from json import dumps
from typing import Any


def stable_hash(value: Any) -> str:
    return sha256(dumps(value, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def tool_call_attributes(tool_name: str, arguments: dict[str, Any], result: str) -> dict[str, Any]:
    return {
        "mcp.tool.name": tool_name,
        "mcp.tool.arguments_hash": stable_hash(arguments),
        "mcp.tool.result_hash": stable_hash(result),
        "mcp.tool.result_size_bytes": len(result.encode("utf-8")),
    }
