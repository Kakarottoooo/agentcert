"""Agent/provider adapter interfaces."""

from __future__ import annotations

from typing import Protocol

from mcpbench.monitor.events import Event


class AgentAdapter(Protocol):
    def run(self) -> list[Event]:
        """Run an agent or deterministic script and return events."""
