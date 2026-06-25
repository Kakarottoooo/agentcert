from __future__ import annotations

from mcpbench.monitor.events import make_event
from mcpbench.telemetry.jsonl import read_jsonl_events, write_jsonl_events


def test_jsonl_trace_roundtrip(tmp_path) -> None:
    path = tmp_path / "events.jsonl"
    events = [
        make_event(
            run_id="run_jsonl",
            sequence_index=1,
            event_type="run_started",
            actor="system",
        )
    ]

    write_jsonl_events(path, events)
    loaded = read_jsonl_events(path)

    assert loaded == events
