"""Taint helpers for canary-backed data-flow evidence."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Taint:
    marker: str
    source_event_id: str
    source_kind: str
