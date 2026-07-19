from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .client import AgentCertClient
from .envelope import new_trace_context


@dataclass
class RunRecorder:
    client: AgentCertClient
    run_id: str
    trace: dict[str, Any]
    batch_size: int = 50
    actor: str = "agent"
    sequence: int = 0
    _pending: list[dict[str, Any]] = field(default_factory=list, init=False, repr=False)

    def __post_init__(self) -> None:
        if not 1 <= self.batch_size <= 500:
            raise ValueError("batch_size must be from 1 to 500")
        if self.sequence < 0:
            raise ValueError("sequence must be non-negative")

    @classmethod
    def start(
        cls,
        client: AgentCertClient,
        run: dict[str, Any],
        *,
        batch_size: int = 50,
        actor: str = "agent",
        next_sequence: int = 0,
    ) -> RunRecorder:
        root = new_trace_context()
        declared = {**run, "traceId": root["traceId"], "rootSpanId": root["spanId"]}
        created = client.start_run(**declared)
        run_id = str(created.get("id") or "")
        if not run_id:
            raise ValueError("AgentCert start_run response did not include an id")
        recorder = cls(client, run_id, root, batch_size, actor, next_sequence)
        recorder.record_event(
            "agentcert.run.started",
            actor="agentcert-sdk-python",
            occurred_at=run.get("startedAt"),
            payload={
                "externalId": run.get("externalId"),
                "kind": run.get("kind"),
                "schemaVersion": run.get("schemaVersion", "agentcert.run.v1"),
            },
            trace=root,
        )
        return recorder

    def child_trace(self, parent: dict[str, Any] | None = None) -> dict[str, Any]:
        return new_trace_context(parent or self.trace)

    def record_event(
        self,
        event_type: str,
        *,
        payload: dict[str, Any] | None = None,
        actor: str | None = None,
        occurred_at: str | None = None,
        trace: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        context = trace or self.child_trace()
        event = {
            "sequence": self.sequence,
            "type": event_type,
            "actor": actor or self.actor,
            "occurredAt": occurred_at or datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "payload": payload or {},
            "traceId": context["traceId"],
            "spanId": context["spanId"],
            **(
                {"parentSpanId": context["parentSpanId"]}
                if context.get("parentSpanId")
                else {}
            ),
        }
        self.sequence += 1
        self._pending.append(event)
        if len(self._pending) >= self.batch_size:
            self.flush()
        return event

    def flush(self) -> None:
        while self._pending:
            batch = self._pending[: self.batch_size]
            try:
                first_sequence = batch[0]["sequence"]
                last_sequence = batch[-1]["sequence"]
                self.client.append_events(
                    self.run_id,
                    batch,
                    idempotency_key=f"events-{first_sequence}-{last_sequence}",
                )
            except Exception:
                raise
            else:
                del self._pending[: len(batch)]

    def complete(self, **result: Any) -> dict[str, Any]:
        self.record_event(
            "agentcert.run.completed",
            actor="agentcert-sdk-python",
            payload={"status": result.get("status"), "score": result.get("score")},
            trace=self.trace,
        )
        self.flush()
        return self.client.complete_run(self.run_id, **result)
