from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any


def new_trace_context(parent: dict[str, Any] | None = None) -> dict[str, Any]:
    parent = parent or {}
    return {
        "traceId": normalize_trace_id(parent.get("traceId")) if parent.get("traceId") else secrets.token_hex(16),
        "spanId": secrets.token_hex(8),
        **({"parentSpanId": normalize_span_id(parent["spanId"])} if parent.get("spanId") else {}),
        "traceFlags": int(parent.get("traceFlags", 1)),
        **({"traceState": str(parent["traceState"])} if parent.get("traceState") else {}),
    }


def event_envelope(
    *,
    agent_id: str,
    run_id: str,
    event_type: str,
    sequence: int,
    attributes: dict[str, Any] | None = None,
    trace: dict[str, Any] | None = None,
    agent_version: str | None = None,
    framework: str | None = None,
    adapter: str | None = None,
    actor: str = "agent",
    envelope_id: str | None = None,
    occurred_at: str | None = None,
    run_kind: str = "custom",
) -> dict[str, Any]:
    source = {"agentId": agent_id}
    if agent_version:
        source["agentVersion"] = agent_version
    if framework:
        source["framework"] = framework
    if adapter:
        source["adapter"] = adapter
    return {
        "schemaVersion": "agentcert.envelope.v0.1",
        "envelopeId": envelope_id or str(uuid.uuid4()),
        "kind": "event",
        "occurredAt": occurred_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": source,
        "run": {"externalId": run_id, "kind": run_kind},
        "trace": trace or new_trace_context(),
        "event": {"sequence": sequence, "type": event_type, "actor": actor, "attributes": attributes or {}},
    }


def normalize_trace_id(value: Any) -> str:
    return _normalized_hex(value, 32)


def normalize_span_id(value: Any) -> str:
    return _normalized_hex(value, 16)


def _normalized_hex(value: Any, length: int) -> str:
    text = str(value or "").lower().replace("-", "")
    if len(text) == length and all(character in "0123456789abcdef" for character in text) and set(text) != {"0"}:
        return text
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:length]
    return digest if set(digest) != {"0"} else ("1" + digest[1:])
