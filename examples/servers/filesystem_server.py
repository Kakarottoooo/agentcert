"""CLI-visible wrapper for the packaged synthetic filesystem registry."""

from __future__ import annotations

import json

from mcpbench.examples.servers.filesystem_server import get_tool_specs

if __name__ == "__main__":
    print(json.dumps([tool.model_dump(mode="json") for tool in get_tool_specs()], indent=2))
