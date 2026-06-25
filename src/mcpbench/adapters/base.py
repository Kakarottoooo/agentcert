"""Adapter interfaces."""

from __future__ import annotations

from typing import Protocol

from mcpbench.models import ToolSpec


class ToolRegistry(Protocol):
    def list_tools(self) -> list[ToolSpec]:
        """Return normalized tool specs."""
