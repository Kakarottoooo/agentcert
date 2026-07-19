# AgentCert Python SDK

```python
import os
from agentcert_sdk import AgentCertClient

agentcert = AgentCertClient(
    base_url=os.environ["AGENTCERT_BASE_URL"],
    project_id=os.environ["AGENTCERT_PROJECT_ID"],
    api_key=os.environ["AGENTCERT_API_KEY"],
)

decision = agentcert.assess_action(
    externalId="purchase-order-4850",
    principal={"id": "procurement-agent", "type": "agent"},
    actionType="SUBMIT",
    targetSystem="MockERP",
    requestedPermissions=["MockERP:SUBMIT"],
    amount=4850,
    currency="USD",
    expectedState={"status": "SUBMITTED"},
)
```

The client uses only the Python standard library at runtime. It cannot register
identities, grant permissions, or approve runtime actions. An owner or admin
configures those controls in the AgentCert console first.

## Framework adapters

Adapters emit `agentcert.envelope.v0.1` without adding framework dependencies
to this package:

```python
from agentcert_sdk.adapters import AgentCertTracingProcessor, BrowserUseAdapter, LangGraphAdapter

# LangGraph: inside `async for event in graph.astream_events(..., version="v2")`
LangGraphAdapter(agentcert, agent_id="research-agent", run_id="run-42").record(event)

# OpenAI Agents SDK
processor = AgentCertTracingProcessor(agentcert, agent_id="support-agent", run_id="run-43")
# add_trace_processor(processor)

# browser-use
on_step_start, on_step_end = BrowserUseAdapter(
    agentcert, agent_id="browser-agent", run_id="run-44"
).hooks()
# Agent(..., register_new_step_callback=on_step_end)
```

See [`docs/universal-envelope.md`](../../docs/universal-envelope.md) for the
field contract and trust boundaries.

## Assurance observability

Use `RunRecorder` when a framework adapter is unnecessary:

```python
from agentcert_sdk import RunRecorder

recorder = RunRecorder.start(agentcert, {
    "externalId": "release-42",
    "kind": "release_gate",
})
recorder.record_event(
    "onegent.outcome.verification",
    payload={"expected": "SUBMITTED", "observed": "SUBMITTED", "success": True},
)
recorder.complete(status="passed")
```

The recorder allocates an ordered sequence and trace-linked spans, sends
bounded batches, and keeps a failed batch pending for an explicit retry. It is
a thin assurance collector, not a general OpenTelemetry backend.
