# Universal Event/Action Envelope v0.1

`agentcert.envelope.v0.1` is the framework-neutral ingestion contract for
AgentCert. It records either an observed agent event or a proposed business
action without pretending that every agent has the same internal workflow.

## Contract

Every envelope contains:

- a caller-stable `envelopeId` used with `Idempotency-Key`;
- source agent, version, framework, and adapter identity;
- an external run ID;
- W3C/OpenTelemetry-compatible 32-hex `traceId` and 16-hex `spanId`;
- exactly one `event` or `action` payload.

The JSON Schema is
[`schemas/agentcert-universal-envelope.schema.json`](../schemas/agentcert-universal-envelope.schema.json).

```json
{
  "schemaVersion": "agentcert.envelope.v0.1",
  "envelopeId": "evt-01",
  "kind": "event",
  "occurredAt": "2026-07-15T12:00:00.000Z",
  "source": {
    "agentId": "research-agent",
    "agentVersion": "1.2.0",
    "framework": "langgraph",
    "adapter": "agentcert.langgraph.v0.1"
  },
  "run": { "externalId": "research-run-42", "kind": "custom" },
  "trace": {
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "traceFlags": 1
  },
  "event": {
    "sequence": 0,
    "type": "tool.started",
    "actor": "agent",
    "attributes": { "tool": "search" }
  }
}
```

Send it to `POST /v1/projects/{projectId}/envelopes` with an API key that has
`runs:write` plus `events:write` or `actions:write`. The server maps event
envelopes into the run timeline and action envelopes into the existing risk,
policy, approval, verification, and audit path. It never bypasses action
policy.

## Reference adapters

The dependency-free Python adapters live under
`packages/agentcert-sdk-python/src/agentcert_sdk/adapters`:

- `LangGraphAdapter.record()` accepts `stream_events` records;
- `AgentCertTracingProcessor` implements the OpenAI Agents SDK tracing
  processor hook shape;
- `BrowserUseAdapter.hooks()` returns async step-start and step-end hooks.

They intentionally use duck typing. Install the relevant agent framework in
the application, not as a transitive AgentCert dependency.

## Trust boundaries

The envelope proves what the authenticated integration reported. It does not
prove the adapter observed every event, that the source agent was uncompromised,
or that a physical-world outcome occurred. Runtime action verification and
uploaded evidence remain separate controls.

## Compatibility

Consumers must reject unknown major contract names. New optional fields may be
added within `v0.1`; required-field or semantic changes require a new schema
version. Trace IDs follow W3C width and non-zero requirements so they can be
correlated with OpenTelemetry backends without claiming AgentCert is a full
telemetry collector.
