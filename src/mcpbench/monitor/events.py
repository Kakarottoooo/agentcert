"""Typed event schema and deterministic event builders."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from mcpbench.utils.hashing import stable_hash
from mcpbench.utils.time import deterministic_timestamp

EventType = Literal[
    "run_started",
    "run_completed",
    "server_started",
    "server_stopped",
    "server_introspected",
    "task_started",
    "task_completed",
    "agent_step_started",
    "agent_step_completed",
    "model_call_started",
    "model_call_completed",
    "tool_call_started",
    "tool_call_completed",
    "tool_call_failed",
    "policy_violation",
    "scorer_result",
    "canary_observed",
    "artifact_written",
]

Actor = Literal["agent", "server", "scorer", "monitor", "system"]


class Event(BaseModel):
    """Shareable JSONL event emitted by evals and analyzed by monitors."""

    model_config = ConfigDict(extra="forbid")

    event_id: str
    run_id: str
    task_id: str | None = None
    timestamp: str
    event_type: EventType
    span_id: str
    parent_span_id: str | None = None
    sequence_index: int
    actor: Actor
    data: dict[str, Any] = Field(default_factory=dict)
    redactions: list[str] = Field(default_factory=list)
    schema_version: str = "1"


def make_event(
    *,
    run_id: str,
    sequence_index: int,
    event_type: EventType,
    actor: Actor,
    data: dict[str, Any] | None = None,
    task_id: str | None = None,
    parent_span_id: str | None = None,
) -> Event:
    """Create a deterministic event suitable for fixtures and offline CI."""

    seed = f"{run_id}:{sequence_index}:{event_type}"
    return Event(
        event_id=f"evt_{stable_hash(seed)}",
        run_id=run_id,
        task_id=task_id,
        timestamp=deterministic_timestamp(sequence_index),
        event_type=event_type,
        span_id=f"span_{stable_hash(seed + ':span')}",
        parent_span_id=parent_span_id,
        sequence_index=sequence_index,
        actor=actor,
        data=data or {},
    )


def make_tool_event_data(
    *,
    tool_name: str,
    tool_call_id: str,
    arguments: dict[str, Any] | None = None,
    result_summary: str | None = None,
    risk_classes: set[str] | list[str] | None = None,
    source_trust: str = "unknown",
    sink_type: str = "none",
    latency_ms: int = 0,
    error: str | None = None,
) -> dict[str, Any]:
    """Build the normalized data payload for tool events."""

    safe_arguments = arguments or {}
    safe_result = result_summary or ""
    return {
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "arguments": safe_arguments,
        "arguments_hash": stable_hash(safe_arguments),
        "result_summary": safe_result,
        "result_hash": stable_hash(safe_result),
        "result_size_bytes": len(safe_result.encode("utf-8")),
        "risk_class": sorted(set(risk_classes or [])),
        "source_trust": source_trust,
        "sink_type": sink_type,
        "latency_ms": latency_ms,
        "error": error,
    }
