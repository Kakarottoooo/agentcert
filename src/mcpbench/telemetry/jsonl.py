"""JSONL event writer and reader."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from mcpbench.monitor.events import Event
from mcpbench.utils.paths import ensure_parent


class JSONLEventWriter:
    """Append-only JSONL sink for deterministic events."""

    def __init__(self, path: Path) -> None:
        self.path = path
        ensure_parent(path)
        self._handle = path.open("w", encoding="utf-8")

    def write(self, event: Event) -> None:
        self._handle.write(event.model_dump_json() + "\n")

    def close(self) -> None:
        self._handle.close()

    def __enter__(self) -> JSONLEventWriter:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def read_jsonl_events(path: Path) -> list[Event]:
    events: list[Event] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                events.append(Event.model_validate_json(stripped))
            except Exception as exc:  # noqa: BLE001 - enrich parse errors for CLI users
                raise ValueError(f"Invalid event JSONL at {path}:{line_number}: {exc}") from exc
    return events


def write_jsonl_events(path: Path, events: Iterable[Event]) -> None:
    with JSONLEventWriter(path) as writer:
        for event in events:
            writer.write(event)
