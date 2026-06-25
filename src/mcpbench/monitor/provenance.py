"""Evidence provenance helpers."""

from __future__ import annotations

from mcpbench.monitor.events import Event


def event_ref(event: Event) -> dict[str, object]:
    return {
        "event_id": event.event_id,
        "event_type": event.event_type,
        "sequence_index": event.sequence_index,
    }
