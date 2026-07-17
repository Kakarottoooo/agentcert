# Onegent Runtime

Onegent Runtime is AgentCert's runtime action boundary package. It lets a
caller capture a proposed high-risk agent action, assess risk, evaluate policy,
request approval, execute only after approval, verify the observed outcome, and
write an audit packet.

The checked-in implementation is local and mock-only. It does not connect to
real payment systems, email providers, vendor portals, production ERPs, or real
credentials.

## Trusted Action Recorder and Mandate v0.1

The trusted runtime adds a stronger evidence path for consequential actions:

- an immutable, Ed25519-signed mandate limits principal, action type, target,
  permissions, business object, amount, currency, and validity window;
- signed run start/end records and strictly increasing event sequences expose
  gaps, duplicates, mutation, and malformed crash tails;
- a durable JSONL queue and acknowledgement file provide at-least-once sink
  delivery after restart;
- execution requires a credential-isolated capability created by
  `createControlledActionAdapter()`;
- a separate read path observes the resulting system state;
- reports distinguish `reported`, `recorded`, `enforced`,
  `outcome_verified`, and `independently_reviewed` evidence.

Run the complete local browser-agent SUBMIT example:

```powershell
npm run build
npm run demo:trusted-browser
```

It reads a local purchase-order page, proposes a $4,850 `SUBMIT`, obtains human
approval, writes through a gateway-only credential, verifies `DRAFT ->
SUBMITTED` through an independent GET endpoint, and emits a signed receipt.
The fixture is a deterministic infrastructure demonstration, not a model
benchmark. See [Action Assurance Protocol v0.1](../../docs/action-assurance-protocol.md).

## SDK

This is currently a repository-local preview package, not a published npm
package. Build and test it from the AgentCert checkout:

```bash
npm --prefix packages/onegent-runtime ci
npm --prefix packages/onegent-runtime run build
npm --prefix packages/onegent-runtime test
```

```ts
import {
  createInMemoryAuditStore,
  createLocalEchoAdapter,
  createOnegentRuntime,
} from "@agentcert/onegent-runtime";

const auditStore = createInMemoryAuditStore();
const runtime = createOnegentRuntime({
  authorizationPolicy: {
    name: "procurement-permissions",
    authorize: (action) => ({
      allowed: action.principal.id === "procurement-agent",
      grantedPermissions: ["MockERP:SUBMIT"],
      reason: "Allowed by the local demo policy.",
    }),
  },
  approvalAdapter: {
    name: "manager-approval",
    requestApproval: async () => ({
      approved: true,
      reviewerId: "manager@example.local",
      reviewerComment: "Approved for demo execution.",
    }),
  },
  auditStore,
});
const review = runtime.captureAction({
  sourceAgentName: "ProcurementAgent",
  principal: { id: "procurement-agent", type: "agent" },
  requestedPermissions: ["MockERP:SUBMIT"],
  actionType: "SUBMIT",
  targetSystem: "MockERP",
  title: "Submit purchase order",
  description: "Submit a high-value purchase order for approval.",
  businessObjectType: "purchase_order",
  businessObjectId: "PO-1001",
  amount: 4850,
  currency: "USD",
  vendorName: "Acme Industrial Supply",
  beforeState: { status: "DRAFT" },
  proposedAfterState: { status: "SUBMITTED" },
});

if (review.authorizationDecision?.decision !== "ALLOW") {
  throw new Error("Action was not authorized.");
}

const risk = runtime.assessRisk(review.action);
const policy = runtime.evaluatePolicy(review.action, risk);
const approval = await runtime.requestApproval(review.action);

if (approval.status !== "APPROVED") throw new Error("Action was not approved.");

const observed = await runtime.executeAfterApproval(review.action, createLocalEchoAdapter());
const verification = runtime.verifyOutcome(review.action, observed);
if (!verification.success) throw new Error("Observed state did not match expected state.");
const auditPacket = await runtime.writeAuditPacket(review.action);
```

The SDK is intentionally adapter-shaped: you bring the authorization policy,
approval workflow, execution adapter, and audit store. Execution is keyed by
`ActionIntent.idempotencyKey`; concurrent retries share one result, and a key
cannot be rebound to a different action. Rollback is an explicit compensating
action implemented by the adapter, never an assumed reversal of a real-world
side effect. Requested permissions
must be included in the policy's granted permissions or the action is blocked.
The checked-in examples are local-only and deterministic so they are safe for
tests and demos.

`createStateSandboxAdapter()` is the reference safety boundary. It refuses
production actions, allows only named synthetic target systems, performs no
network access, snapshots previous state, and implements deterministic
rollback. `createJsonlAuditStore()` provides an append-only local audit sink;
hosted or customer-managed stores can implement the same `AuditStore`
contract.

## Sandbox Certification Harness

Run the active local certification suite:

```powershell
npm run build
node dist/cli.js sandbox-certify --out .onegent/sandbox-certification
```

It tests tenant isolation, synthetic-data enforcement, network denial, target
allowlisting, production denial, approval, execution limits, kill switches,
idempotency, verification, rollback, and reset. The versioned JSON report is
validated by `sandbox-certification.schema.json`.

Programmatic entry points:

- `createSandboxCertificationHarness()` creates the bounded tenant/run API;
- `createInMemorySandboxSystem()` is the local synthetic reference system;
- `runSandboxCertificationSuite()` actively exercises all ten controls;
- `writeSandboxReport()` writes a private local report.

See [the full harness guide](../../docs/sandbox-certification-harness.md).

## Sandbox Adapter Kit v0.2

```powershell
npm run build
node dist/cli.js sandbox-conformance --out .onegent/sandbox-conformance
```

`createSandboxSystemAdapter()` provides the guarded callback template for
third-party systems. `runSandboxAdapterConformanceSuite()` verifies the adapter,
the ten v0.1 controls, tenant lifecycle, and tenant TTL cleanup. Harness tenants
expire after one hour by default and are deleted on expiry or `close()`.

Use `createStripeTestModeReadOnlyAdapter()` for the vendor reference boundary.
It accepts only a restricted `rk_test_` key and exposes bounded PaymentIntent
GET operations; it cannot execute a payment mutation. The boundary checks the
exact HTTPS origin, method, and resource route before network access, then
applies a 5-second timeout and process-local request cap. Use the public
`npx agentcert sandbox stripe-readonly --payment-intent pi_...` command to
produce and optionally upload the redacted v0.4 report.

Add `--push` to either sandbox command to create a Hosted Control Plane run and
upload the report as complete evidence. Configure `AGENTCERT_PROJECT_ID`,
`AGENTCERT_API_KEY`, and optionally `AGENTCERT_BASE_URL`; the API key needs
`runs:write` and `evidence:write`.

See [the Adapter Kit guide](../../docs/sandbox-adapter-kit.md) and the
[runnable third-party template](../../examples/onegent/sandbox-system-adapter-template.mjs).

## Demo

```powershell
npm --prefix packages/onegent-runtime ci
npm --prefix packages/onegent-runtime run build
npm --prefix packages/onegent-runtime run demo:procurement
npm --prefix packages/onegent-runtime run demo:trusted-browser
```

Outputs:

- `.onegent/procurement/walkthrough-before-approval.html`
- `.onegent/procurement/walkthrough-after-approval.html`
- `.onegent/procurement/audit-packet.json`
- `.onegent/trusted-browser-submit/trusted-audit-packet.json`
- `.onegent/trusted-browser-submit/recorder/browser-submit-po-4850-<execution-id>.journal.jsonl`
- `.onegent/trusted-browser-submit/trusted-browser-submit.html`

## Local Server

```powershell
npm --prefix packages/onegent-runtime run serve
```

Open:

```text
http://localhost:3310/action-gateway/walkthrough/procurement
```
