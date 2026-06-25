"""CLI-visible wrapper for the packaged synthetic database registry."""

from __future__ import annotations

import json

from mcpbench.examples.servers.duckdb_like_server import get_tool_specs

if __name__ == "__main__":
    print(json.dumps([tool.model_dump(mode="json") for tool in get_tool_specs()], indent=2))
