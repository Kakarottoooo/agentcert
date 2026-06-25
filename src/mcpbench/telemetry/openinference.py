"""OpenInference mapping notes placeholder."""

from __future__ import annotations

from mcpbench.monitor.events import Event


def event_to_openinference_attributes(event: Event) -> dict[str, object]:
    return {
        "mcpbench.event_id": event.event_id,
        "mcpbench.event_type": event.event_type,
        "mcpbench.sequence_index": event.sequence_index,
    }
