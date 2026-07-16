from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from agentcert_sdk.adapters import AgentCertTracingProcessor, BrowserUseAdapter, LangGraphAdapter


class RecordingClient:
    def __init__(self) -> None:
        self.envelopes: list[dict[str, Any]] = []

    def send_envelope(self, envelope: dict[str, Any]) -> dict[str, Any]:
        self.envelopes.append(envelope)
        return {"accepted": True}


def test_langgraph_adapter_maps_stream_events_to_universal_envelopes() -> None:
    client = RecordingClient()
    adapter = LangGraphAdapter(client, agent_id="research-agent", run_id="run-1")  # type: ignore[arg-type]
    adapter.record(
        {"event": "on_tool_start", "name": "search", "run_id": "span-a", "data": {"input": "query"}}
    )

    envelope = client.envelopes[0]
    assert envelope["schemaVersion"] == "agentcert.envelope.v0.1"
    assert envelope["source"]["framework"] == "langgraph"
    assert envelope["event"]["type"] == "on_tool_start"
    assert len(envelope["trace"]["traceId"]) == 32


def test_openai_agents_processor_matches_processor_hook_shape() -> None:
    client = RecordingClient()
    processor = AgentCertTracingProcessor(client, agent_id="support-agent", run_id="run-2")  # type: ignore[arg-type]
    span = SimpleNamespace(
        trace_id="1" * 32, span_id="2" * 16, parent_id=None, span_data={"tool": "lookup"}
    )
    processor.on_span_start(span)
    processor.on_span_end(span)
    processor.force_flush()
    processor.shutdown()

    assert [item["event"]["type"] for item in client.envelopes] == [
        "openai.span.started",
        "openai.span.ended",
    ]
    assert client.envelopes[0]["trace"]["traceId"] == "1" * 32


def test_browser_use_adapter_exposes_async_step_hooks_and_bounds_state() -> None:
    client = RecordingClient()
    adapter = BrowserUseAdapter(client, agent_id="browser-agent", run_id="run-3")  # type: ignore[arg-type]
    on_start, on_end = adapter.hooks()
    agent = SimpleNamespace(
        state=SimpleNamespace(url="https://example.test", last_action="click", last_result="ok"),
        history=[1, 2],
    )
    asyncio.run(on_start(agent))
    asyncio.run(on_end(agent))

    assert len(client.envelopes) == 2
    assert client.envelopes[0]["event"]["attributes"]["currentUrl"] == "https://example.test"
    assert client.envelopes[1]["event"]["type"] == "browser_use.step.ended"
