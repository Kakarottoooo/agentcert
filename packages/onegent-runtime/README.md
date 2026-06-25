# Onegent Runtime

Onegent Runtime is AgentCert's runtime action boundary package. It lets a
caller capture a proposed high-risk agent action, assess risk, evaluate policy,
request approval, execute only after approval, verify the observed outcome, and
write an audit packet.

The checked-in implementation is local and mock-only. It does not connect to
real payment systems, email providers, vendor portals, production ERPs, or real
credentials.

## SDK

```ts
import {
  createInMemoryAuditStore,
  createLocalEchoAdapter,
  createOnegentRuntime,
} from "@agentcert/onegent-runtime";

const auditStore = createInMemoryAuditStore();
const runtime = createOnegentRuntime({
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

const risk = runtime.assessRisk(review.action);
const policy = runtime.evaluatePolicy(review.action, risk);
const approval = await runtime.requestApproval(review.action);

if (approval.status !== "APPROVED") throw new Error("Action was not approved.");

const observed = await runtime.executeAfterApproval(review.action, createLocalEchoAdapter());
const verification = runtime.verifyOutcome(review.action, observed);
if (!verification.success) throw new Error("Observed state did not match expected state.");
const auditPacket = await runtime.writeAuditPacket(review.action);
```

The SDK is intentionally adapter-shaped: you bring the approval workflow, the
execution adapter, and the audit store. The checked-in examples are local-only
and deterministic so they are safe for tests and demos.

## Demo

```powershell
npm --prefix packages/onegent-runtime ci
npm --prefix packages/onegent-runtime run build
npm --prefix packages/onegent-runtime run demo:procurement
```

Outputs:

- `.onegent/procurement/walkthrough-before-approval.html`
- `.onegent/procurement/walkthrough-after-approval.html`
- `.onegent/procurement/audit-packet.json`

## Local Server

```powershell
npm --prefix packages/onegent-runtime run serve
```

Open:

```text
http://localhost:3310/action-gateway/walkthrough/procurement
```
