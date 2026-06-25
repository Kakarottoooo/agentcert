"""Replay adapter for existing JSONL traces."""

from __future__ import annotations

from pathlib import Path

from mcpbench.monitor.events import Event
from mcpbench.telemetry.jsonl import read_jsonl_events


def load_replay_trace(path: Path) -> list[Event]:
    return read_jsonl_events(path)
