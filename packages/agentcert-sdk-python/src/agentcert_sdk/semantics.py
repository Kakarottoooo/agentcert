from __future__ import annotations

import hashlib
import inspect
import json
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from .recorder import RunRecorder

Input = TypeVar("Input")
Output = TypeVar("Output")


def instrument_tool(
    recorder: RunRecorder,
    capability: dict[str, Any],
    execute: Callable[[Input], Output],
    *,
    tool_name: str | None = None,
    resource: Callable[[Input], dict[str, str] | None] | None = None,
) -> Callable[[Input], Output]:
    _validate_capability(capability)
    observed_name = tool_name or str(capability["id"])

    def wrapped(input_value: Input) -> Output:
        invocation_id = str(uuid.uuid4())
        trace = recorder.child_trace()
        common = _semantic(capability, observed_name, invocation_id, resource, input_value)
        recorder.record_event(
            "agentcert.tool.started",
            payload={"semantic": {**common, "phase": "started"}, "input": _descriptor(input_value)},
            trace=trace,
        )
        try:
            output = execute(input_value)
            if inspect.isawaitable(output):
                if inspect.iscoroutine(output):
                    output.close()
                raise TypeError("instrument_tool received an async tool; use instrument_async_tool")
        except Exception as error:
            recorder.record_event(
                "agentcert.tool.failed",
                payload={"semantic": {**common, "phase": "failed"}, "error": _error(error)},
                trace=trace,
            )
            raise
        recorder.record_event(
            "agentcert.tool.completed",
            payload={"semantic": {**common, "phase": "completed"}, "output": _descriptor(output)},
            trace=trace,
        )
        return output

    return wrapped


def instrument_async_tool(
    recorder: RunRecorder,
    capability: dict[str, Any],
    execute: Callable[[Input], Awaitable[Output]],
    *,
    tool_name: str | None = None,
    resource: Callable[[Input], dict[str, str] | None] | None = None,
) -> Callable[[Input], Awaitable[Output]]:
    _validate_capability(capability)
    observed_name = tool_name or str(capability["id"])

    async def wrapped(input_value: Input) -> Output:
        invocation_id = str(uuid.uuid4())
        trace = recorder.child_trace()
        common = _semantic(capability, observed_name, invocation_id, resource, input_value)
        recorder.record_event(
            "agentcert.tool.started",
            payload={"semantic": {**common, "phase": "started"}, "input": _descriptor(input_value)},
            trace=trace,
        )
        try:
            output = await execute(input_value)
        except Exception as error:
            recorder.record_event(
                "agentcert.tool.failed",
                payload={"semantic": {**common, "phase": "failed"}, "error": _error(error)},
                trace=trace,
            )
            raise
        recorder.record_event(
            "agentcert.tool.completed",
            payload={"semantic": {**common, "phase": "completed"}, "output": _descriptor(output)},
            trace=trace,
        )
        return output

    return wrapped


def _semantic(
    capability: dict[str, Any],
    observed_name: str,
    invocation_id: str,
    resource: Callable[[Input], dict[str, str] | None] | None,
    input_value: Input,
) -> dict[str, Any]:
    resolved_resource = resource(input_value) if resource else None
    return {
        "schemaVersion": "agentcert.semantic_event.v0.1",
        "capabilityId": capability["id"],
        "observedName": observed_name,
        "invocationId": invocation_id,
        **({"resource": resolved_resource} if resolved_resource else {}),
    }


def _descriptor(value: Any) -> dict[str, Any]:
    normalized = _serializable(value)
    encoded = json.dumps(
        normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return {
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "sizeBytes": len(encoded),
        "shape": _shape(value),
    }


def _serializable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_serializable(item) for item in value[:100]]
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if _sensitive(str(key)) else _serializable(item)
            for key, item in list(value.items())[:100]
        }
    return str(value)


def _shape(value: Any) -> str | list[str]:
    if isinstance(value, (list, tuple)):
        return f"array({len(value)})"
    if isinstance(value, dict):
        return [str(key) for key in value if not _sensitive(str(key))][:30]
    return type(value).__name__


def _error(error: Exception) -> dict[str, str]:
    message = str(error)
    return {
        "name": type(error).__name__,
        "message": message[:500] + ("..." if len(message) > 500 else ""),
    }


def _validate_capability(value: dict[str, Any]) -> None:
    if value.get("schemaVersion") != "agentcert.capability_manifest.v0.1" or not value.get("id"):
        raise ValueError("A valid AgentCert capability manifest is required")


def _sensitive(key: str) -> bool:
    normalized = key.lower().replace("_", "").replace("-", "")
    return any(
        part in normalized
        for part in (
            "token",
            "secret",
            "password",
            "authorization",
            "cookie",
            "credential",
            "apikey",
        )
    )
