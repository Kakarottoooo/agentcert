"""Deterministic timestamp helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

BASE_TIME = datetime(2026, 1, 1, tzinfo=UTC)


def deterministic_timestamp(sequence_index: int) -> str:
    return (BASE_TIME + timedelta(seconds=sequence_index)).isoformat().replace("+00:00", "Z")
