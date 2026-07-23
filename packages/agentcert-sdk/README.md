# AgentCert TypeScript SDK

```ts
import { AgentCertClient } from "agentcert-sdk";

const agentcert = new AgentCertClient({
  baseUrl: process.env.AGENTCERT_BASE_URL!,
  projectId: process.env.AGENTCERT_PROJECT_ID!,
  apiKey: process.env.AGENTCERT_API_KEY!,
});

const action = await agentcert.assessAction({
  externalId: "purchase-order-4850",
  principal: { id: "procurement-agent", type: "agent" },
  actionType: "SUBMIT",
  targetSystem: "MockERP",
  requestedPermissions: ["MockERP:SUBMIT"],
  amount: 4850,
  currency: "USD",
  expectedState: { status: "SUBMITTED" },
});

if (action.decision === "REQUIRE_APPROVAL") {
  // Poll getAction(action.id), or wait for your approval webhook integration.
}
```

The SDK submits intent and evidence. It never executes payments, sends email,
mutates external systems, approves actions, or changes agent permissions.
Owners and admins register agent identities and grant permissions in the human
console before giving a project API key to an agent or CI job.

## Continuous assurance runs

An issued assurance case can be bound to the exact agent, model, prompt,
tools, policy, and scenario suite evaluated by CI:

```ts
const run = await agentcert.startRun({
  externalId: "release-2.4.0",
  kind: "release_gate",
  assurance: {
    caseId: process.env.AGENTCERT_ASSURANCE_CASE_ID!,
    trigger: "release",
    scope: {
      schemaVersion: "agentcert.assurance_scope.v0.1",
      agent: { id: "browser-agent", version: "2.4.0", artifactSha256: "a".repeat(64) },
      model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
      prompt: { sha256: "b".repeat(64) },
      tools: { manifestSha256: "c".repeat(64) },
      policy: { id: "agentcert.browser", version: "0.1.0", sha256: "d".repeat(64) },
      scenarioSuite: { id: "tripwire", version: "2026.07", sha256: "e".repeat(64) },
    },
  },
});
```

The server reserves the run's assurance metadata, compares canonical scope
fingerprints, and reconciles each run once even when completion is retried.

## Controlled action runtime

The runtime is part of the same package, not a separate AgentCert product:

```ts
import {
  createInMemoryAuditStore,
  createLocalEchoAdapter,
  createAgentCertRuntime,
} from "agentcert-sdk/runtime";

const runtime = createAgentCertRuntime({
  auditStore: createInMemoryAuditStore(),
  approvalAdapter: {
    name: "human-review",
    requestApproval: async () => ({ approved: true, reviewerId: "reviewer@example.com" }),
  },
});

const review = runtime.captureAction({
  sourceAgentName: "ProcurementAgent",
  principal: { id: "procurement-agent", type: "agent" },
  requestedPermissions: ["MockERP:SUBMIT"],
  actionType: "SUBMIT",
  targetSystem: "MockERP",
  title: "Submit purchase order",
  description: "Submit one approved sandbox purchase order.",
  businessObjectType: "purchase_order",
  businessObjectId: "PO-1001",
  beforeState: { status: "DRAFT" },
  proposedAfterState: { status: "SUBMITTED" },
});

const approval = await runtime.requestApproval(review.action);
if (approval.status !== "APPROVED") throw new Error("Approval required");
const observed = await runtime.executeAfterApproval(review.action, createLocalEchoAdapter());
const verification = runtime.verifyOutcome(review.action, observed);
const audit = await runtime.writeAuditPacket(review.action);
```

Production integrations should use `createAgentCertTrustedActionRuntime()` from the
same subpath. It requires a signed mandate, a gap-detectable recorder, a
registered credential-holding execution adapter, and an independent outcome
probe. The bundled local adapters are deterministic examples and must not be
treated as production-system connectors.

The SDK also exports `createEventEnvelope()` and `sendEnvelope()` for
framework-neutral event ingestion. `verifyServerAttestation()` verifies the
canonical Ed25519 metadata chain returned on hosted evidence records against
the public key from `GET /v1/signing-keys/current`.

## Assurance observability

`AgentCertRunRecorder` is the thin framework-neutral path for ordered,
OpenTelemetry-compatible run events. It owns sequence allocation, trace/span
IDs, bounded batches, retry-safe pending records, and flush-before-complete:

```ts
import { AgentCertClient, AgentCertRunRecorder } from "agentcert-sdk";

const recorder = await AgentCertRunRecorder.start(agentcert, {
  externalId: process.env.GITHUB_SHA ?? "local-run",
  kind: "release_gate",
});
await recorder.recordEvent({
  type: "tripwire.fault.assertion",
  payload: { fault: "button-text-drift", passed: true },
});
await recorder.complete({ status: "passed" });
```

The recorder does not execute actions or become a general-purpose APM agent.
See [`docs/observability.md`](../../docs/observability.md) for event limits,
query semantics, trust boundaries, and non-claims.

## Universal tool semantics

Wrap a tool once to emit redacted, invocation-linked semantic events:

```ts
import { instrumentTool } from "agentcert-sdk";

const sendMessage = instrumentTool({
  recorder,
  capability: {
    schemaVersion: "agentcert.capability_manifest.v0.1",
    id: "messaging.send", version: "0.1.0", name: "Send message",
    domain: "messaging", operations: ["send"], sideEffect: "external",
    resourceTypes: ["message"], requiredPermissions: ["messages:send"],
    risk: "high", idempotency: "required", reversibility: "irreversible",
    enforcement: "gateway", verification: "independent_probe",
  },
  toolName: "send_email",
  execute: async (input) => mailSandbox.send(input),
});
```

The wrapper records bounded hashes and shapes, not raw secrets. Producer events
establish observed/recorded coverage only; controlled Action records and
independent probes establish enforced/verified coverage. See
[`docs/universal-agent-semantics.md`](../../docs/universal-agent-semantics.md).

## Customer-owned collector gateway

`agentcert-sdk` includes a customer-owned process that holds the source
signing key, Hosted API key, and durable offline queue outside the agent
process. It provides idempotent local append, signed heartbeat, restart replay,
receipt reconciliation, key rotation, and a black-box conformance command.

```bash
npx --package agentcert-sdk agentcert-collector-gateway
npx --package agentcert-sdk agentcert-collector-conformance
```

Required gateway environment variables are `AGENTCERT_PROJECT_ID`,
`AGENTCERT_API_KEY`, and `AGENTCERT_GATEWAY_TOKEN`. See
[`docs/customer-owned-collector-gateway.md`](../../docs/customer-owned-collector-gateway.md)
for Docker deployment, protocol details, and non-claims.
