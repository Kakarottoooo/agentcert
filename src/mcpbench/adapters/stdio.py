"""Future stdio MCP adapter boundary."""

from __future__ import annotations


class StdioMCPAdapter:
    """Interface placeholder for real MCP stdio support after the MVP."""

    def __init__(self, command: str) -> None:
        self.command = command

    def list_tools(self) -> list[object]:
        raise NotImplementedError("Real MCP stdio introspection is planned after the offline MVP.")
