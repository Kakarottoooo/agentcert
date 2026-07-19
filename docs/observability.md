# Assurance Observability v0.1

AgentCert observability answers assurance questions from records the product
already owns: what an agent attempted, which policy decided it, whether approval
was required, what the target system actually reported, and whether the
evidence chain is complete. It is not a replacement for application logging,
OpenTelemetry storage, LangSmith, or infrastructure APM.

## Unified model

One run can correlate five entity types without copying them into a second
database:

| Entity | Purpose |
| --- | --- |
| `run` | One MCPBench, Tripwire, release-gate, runtime, or custom execution. |
| `event` | An ordered agent, tool, policy, fault, or verification observation. |
| `action` | A proposed `SUBMIT`, `PAY`, `SEND`, or `UPDATE` action and policy decision. |
| `approval` | The human decision linked to a high-risk action. |
| `evidence` | A hash-addressed artifact linked to the run or action. |

Runs declare 32-hex-character `traceId` and 16-hex-character `rootSpanId`
values. Events and actions may declare their own `spanId` and `parentSpanId`.
These identifiers are W3C/OpenTelemetry-compatible, but AgentCert does not
claim to be an OpenTelemetry backend or accept arbitrary telemetry volume.

Event sequences are append-only. A batch may contain at most 500 events, each
payload is limited to 64 KiB, and an existing sequence cannot be rewritten.
The trace read model reports missing sequence numbers, mixed trace IDs, missing
root context, and orphan parent spans instead of silently presenting a complete
timeline.

## Thin SDK collection

The TypeScript and Python SDKs write directly to existing project-scoped run
and event endpoints. They have no framework dependency and buffer no more than
the configured batch size.

```ts
import { AgentCertClient, AgentCertRunRecorder } from "agentcert-sdk";

const client = new AgentCertClient({
  baseUrl: process.env.AGENTCERT_BASE_URL!,
  projectId: process.env.AGENTCERT_PROJECT_ID!,
  apiKey: process.env.AGENTCERT_API_KEY!,
});

const recorder = await AgentCertRunRecorder.start(client, {
  externalId: process.env.GITHUB_SHA ?? "local-run",
  kind: "release_gate",
});
await recorder.recordEvent({
  type: "tripwire.fault.assertion",
  payload: { fault: "prompt-injection-banner", passed: false },
});
await recorder.complete({ status: "failed", summary: "Fault assertion failed." });
```

```python
from agentcert_sdk import AgentCertClient, RunRecorder

client = AgentCertClient(base_url, project_id, api_key)
recorder = RunRecorder.start(client, {
    "externalId": "release-42",
    "kind": "release_gate",
})
recorder.record_event(
    "onegent.outcome.verification",
    payload={"expected": "SUBMITTED", "observed": "DRAFT", "success": False},
)
recorder.complete(status="failed", summary="Observed state did not match.")
```

The CLI emits the same structured model for current products:

- `tripwire.fault.assertion` for each deterministic browser fault;
- `mcpbench.policy.violation` and policy assertions;
- `onegent.policy.decision`, `onegent.approval.decision`, and
  `onegent.outcome.verification`; and
- run-start, product-result, evidence-upload, and run-evaluated events.

Payloads are recursively bounded before upload and suspicious credential field
names are replaced with `[REDACTED]`. This is a defensive guard, not permission
to put customer secrets into event payloads.

## Hosted read paths

`GET /v1/projects/{projectId}/runs/{runId}/analysis` returns the run, ordered
events, trace-correlated actions and approvals, linked evidence, evidence
completeness, and `agentcert.run_observability.v0.1`.

`GET /v1/projects/{projectId}/observability?days=30` returns
`agentcert.observability_snapshot.v0.1` for a 7, 30, or 90-day window:

- run pass rate and authoritative `CURRENT` rate;
- fault assertion pass rate;
- high-risk, blocked, and approval-required actions;
- expected-versus-observed verification failures;
- approval latency, policy reasons, risk distribution, and daily activity.

Aggregate reads are bounded to 10,000 records per entity. The response exposes
`truncated.any` and per-entity truncation flags whenever that safety bound is
reached, so partial metrics cannot masquerade as complete.

The Hosted Overview renders the aggregate assurance window. The Runs workspace
renders one nested trace with an explicit risk strip and integrity diagnostics.
It correlates the original database rows at read time; there is no duplicate
trace service or parallel analytics identity.

## Storage and access

Postgres remains the system of record. Existing JSONB payloads hold
framework-specific attributes, while indexed project/time/type, trace/risk,
and approval/time columns support the bounded read paths. In-memory storage is
used only by tests and local development.

Project API keys need only `runs:write` and `events:write` to collect data.
Continuous CI additionally needs `runs:read` and `evidence:write` to verify
Hosted `CURRENT`. Reading correlated runtime actions requires `actions:read`;
a continuous-CI key cannot retrieve action details.

## What this proves

- received records can be ordered and correlated across run, policy, approval,
  action, outcome, and evidence boundaries;
- gaps, duplicate sequence attempts, mixed traces, and partial aggregate
  windows are observable; and
- declared expected state can be compared with an independently observed
  action outcome when an outcome probe is present.

It does not prove that an uninstrumented action was captured, that an agent
could not bypass an optional recorder, or that an event payload is truthful.
Those stronger claims require the enforced gateway, customer-owned collector,
source signatures, mandate binding, independent outcome probes, and server
attestation described in the action-assurance protocol.
