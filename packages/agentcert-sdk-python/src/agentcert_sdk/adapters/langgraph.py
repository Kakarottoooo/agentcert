from __future__ import annotations

from typing import Any, Iterable

from ..client import AgentCertClient
from ..envelope import event_envelope, new_trace_context, normalize_span_id, normalize_trace_id


class LangGraphAdapter:
    """Consumes LangGraph stream_events records without importing LangGraph."""

    def __init__(self, client: AgentCertClient, *, agent_id: str, run_id: str, agent_version: str | None = None):
        self.client = client
        self.agent_id = agent_id
        self.run_id = run_id
        self.agent_version = agent_version
        self.sequence = 0
        self.root_trace = new_trace_context()

    def record(self, raw_event: dict[str, Any]) -> dict[str, Any]:
        metadata = _mapping(raw_event.get("metadata"))
        trace_id = normalize_trace_id(metadata.get("trace_id") or raw_event.get("run_id") or self.root_trace["traceId"])
        parent_ids = raw_event.get("parent_ids") if isinstance(raw_event.get("parent_ids"), list) else []
        trace = {
            "traceId": trace_id,
            "spanId": normalize_span_id(raw_event.get("run_id") or f"langgraph-{self.sequence}"),
            **({"parentSpanId": normalize_span_id(parent_ids[-1])} if parent_ids else {}),
            "traceFlags": 1,
        }
        envelope = event_envelope(
            agent_id=self.agent_id,
            agent_version=self.agent_version,
            run_id=self.run_id,
            event_type=str(raw_event.get("event") or "langgraph.event"),
            sequence=self.sequence,
            attributes={
                "name": raw_event.get("name"),
                "tags": raw_event.get("tags") if isinstance(raw_event.get("tags"), list) else [],
                "data": _mapping(raw_event.get("data")),
                "metadata": metadata,
            },
            trace=trace,
            framework="langgraph",
            adapter="agentcert.langgraph.v0.1",
        )
        self.sequence += 1
        return self.client.send_envelope(envelope)

    def record_all(self, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self.record(event) for event in events]


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}
