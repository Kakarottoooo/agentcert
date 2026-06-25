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
import { createOnegentRuntime } from "@agentcert/onegent-runtime";

const runtime = createOnegentRuntime();
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
const approval = runtime.requestApproval(review.action);

runtime.approveAction(review.action);
const observed = await runtime.executeAfterApproval(review.action, {
  name: "local-adapter",
  execute: async (action) => ({
    method: "LOCAL_ADAPTER",
    previousState: action.beforeState,
    observedState: action.proposedAfterState,
  }),
});
runtime.verifyOutcome(review.action, observed);

const auditPacket = runtime.writeAuditPacket(review.action);
```

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
