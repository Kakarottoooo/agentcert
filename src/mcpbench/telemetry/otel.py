"""Optional OpenTelemetry export hook."""

from __future__ import annotations

from collections.abc import Iterable

from mcpbench.monitor.events import Event


def export_events_to_otel(_events: Iterable[Event]) -> int:
    """Future optional exporter; returns zero exported spans in the MVP."""

    return 0
