"""Deterministic mock provider."""

from __future__ import annotations

from mcpbench.evals.runner import scripted_events
from mcpbench.monitor.events import Event


def run_mock(script: str = "passing") -> list[Event]:
    return scripted_events(script=script, suite="basic-tool-use")
