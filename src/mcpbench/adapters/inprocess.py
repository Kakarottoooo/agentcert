"""In-process tool registry adapter for offline examples."""

from __future__ import annotations

from dataclasses import dataclass

from mcpbench.models import ToolSpec


@dataclass
class InProcessToolRegistry:
    tools: list[ToolSpec]

    def list_tools(self) -> list[ToolSpec]:
        return self.tools
