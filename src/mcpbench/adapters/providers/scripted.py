"""Deterministic scripted provider."""

from __future__ import annotations

from mcpbench.evals.runner import scripted_events
from mcpbench.monitor.events import Event


def run_scripted(script: str, suite: str) -> list[Event]:
    return scripted_events(script=script, suite=suite)
