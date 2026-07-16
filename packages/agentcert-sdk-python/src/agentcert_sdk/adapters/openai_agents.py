from __future__ import annotations

from typing import Any

from ..client import AgentCertClient
from ..envelope import event_envelope, normalize_span_id, normalize_trace_id


class AgentCertTracingProcessor:
    """Duck-typed OpenAI Agents SDK tracing processor with no SDK dependency."""

    def __init__(self, client: AgentCertClient, *, agent_id: str, run_id: str, agent_version: str | None = None):
        self.client = client
        self.agent_id = agent_id
        self.run_id = run_id
        self.agent_version = agent_version
        self.sequence = 0

    def on_trace_start(self, trace: Any) -> None:
        self._record("openai.trace.started", trace)

    def on_trace_end(self, trace: Any) -> None:
        self._record("openai.trace.ended", trace)

    def on_span_start(self, span: Any) -> None:
        self._record("openai.span.started", span)

    def on_span_end(self, span: Any) -> None:
        self._record("openai.span.ended", span)

    def force_flush(self) -> None:
        return None

    def shutdown(self) -> None:
        return None

    def _record(self, event_type: str, item: Any) -> None:
        trace_id = normalize_trace_id(_read(item, "trace_id") or self.run_id)
        span_id = normalize_span_id(_read(item, "span_id") or f"openai-{self.sequence}")
        parent_id = _read(item, "parent_id")
        attributes = {
            "name": _read(item, "name") or _read(item, "workflow_name"),
            "groupId": _read(item, "group_id"),
            "metadata": _mapping(_read(item, "metadata")),
            "data": _safe_data(_read(item, "span_data") or _read(item, "data")),
        }
        envelope = event_envelope(
            agent_id=self.agent_id,
            agent_version=self.agent_version,
            run_id=self.run_id,
            event_type=event_type,
            sequence=self.sequence,
            attributes={key: value for key, value in attributes.items() if value is not None},
            trace={"traceId": trace_id, "spanId": span_id, **({"parentSpanId": normalize_span_id(parent_id)} if parent_id else {}), "traceFlags": 1},
            framework="openai-agents",
            adapter="agentcert.openai_agents.v0.1",
        )
        self.sequence += 1
        self.client.send_envelope(envelope)


def _read(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_data(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool, list, dict)):
        return value
    if hasattr(value, "export"):
        exported = value.export()
        return exported if isinstance(exported, dict) else {"value": str(exported)}
    return {"type": type(value).__name__}
