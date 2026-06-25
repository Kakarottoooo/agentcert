# Onegent Runtime

Onegent Runtime is the production action-boundary layer in AgentCert. The current repository contains a local Action Gateway MVP for customer demos and deterministic tests.

Unlike MCPBench and Tripwire CI, it does not ask whether an agent should ship. It asks whether one live action should be allowed right now.

## Implemented MVP

- receives proposed actions from an agent or tool gateway;
- supports `SUBMIT`, `PAY`, `SEND`, and `UPDATE` action intents;
- classifies action risk;
- evaluates deterministic local policy;
- supports policy-as-code with `onegent.policy.json`;
- requires human approval when needed;
- mock-executes only after approval;
- verifies expected state against observed local mock state;
- records audit events;
- exports an audit packet.

## SDK Surface

Onegent Runtime can now be embedded as a small SDK around a high-risk action
boundary. The default implementation is still local and mock-only, but the
control flow is the production shape:

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
const approval = runtime.requestApproval(review.action, "manager@example.local");

runtime.approveAction(review.action, "manager@example.local");
runtime.executeAfterApproval(review.action);
runtime.verifyOutcome(review.action);

const auditPacket = runtime.writeAuditPacket(review.action);
```

The intended integration points are:

- `assessRisk(action)`;
- `evaluatePolicy(action)`;
- `requestApproval(action)`;
- `executeAfterApproval(action)`;
- `verifyOutcome(action)`;
- `writeAuditPacket(action)`.

Adapters for real systems should wrap `executeAfterApproval` and
`verifyOutcome` behind explicit credential, approval, rollback, and audit
boundaries. The repository implementation remains local and deterministic.

## Procurement Walkthrough

The demo scenario is a `ProcurementAgent` submitting a `$4,850` purchase order to `Acme Industrial Supply`. The purchase order starts in local mock ERP state `DRAFT`. Because purchase orders over `$1,000` require human approval, the action is classified as `HIGH` risk and waits for approval before execution.

After approval, the runtime updates only the local mock ERP purchase order from `DRAFT` to `SUBMITTED`, verifies that the observed mock state matches the expected state, and generates an audit packet.

Run the static demo export:

```powershell
npm --prefix packages/onegent-runtime ci
npm --prefix packages/onegent-runtime run build
npm --prefix packages/onegent-runtime run demo:procurement
```

Run with an explicit policy file:

```powershell
npm --prefix packages/onegent-runtime run demo:procurement -- --policy onegent.policy.json
```

Run the local server:

```powershell
npm --prefix packages/onegent-runtime run serve
```

Open:

```text
http://localhost:3310/action-gateway/walkthrough/procurement
```

## Local API Routes

The current project has no web framework, so the MVP exposes framework-free local route equivalents through Node's built-in HTTP server:

- `GET /api/action-gateway/actions`
- `POST /api/action-gateway/actions`
- `GET /api/action-gateway/actions/:id`
- `POST /api/action-gateway/actions/:id/approve`
- `POST /api/action-gateway/actions/:id/reject`
- `POST /api/action-gateway/actions/:id/verify`
- `GET /api/action-gateway/actions/:id/audit-packet`
- `GET /api/action-gateway/demo/procurement`
- `POST /api/action-gateway/demo/procurement/reset`
- `POST /api/action-gateway/demo/procurement/approve`
- `GET /mock-systems/procurement/purchase-orders/:id`

## Policy-As-Code

Policy files use a small deterministic JSON format:

```json
{
  "schemaVersion": "1",
  "rules": [
    {
      "id": "po-over-1000-requires-approval",
      "name": "Purchase orders over $1,000 require approval",
      "description": "High-value purchase order submissions must be reviewed before mock execution.",
      "actionTypes": ["SUBMIT"],
      "effect": "REQUIRE_APPROVAL",
      "enabled": true,
      "conditions": [
        {
          "field": "amount",
          "operator": "greaterThan",
          "value": 1000
        }
      ]
    }
  ]
}
```

Supported effects:

- `ALLOW`
- `REQUIRE_APPROVAL`
- `BLOCK`

Supported operators:

- `equals`
- `notEquals`
- `greaterThan`
- `greaterThanOrEqual`
- `lessThan`
- `lessThanOrEqual`
- `includes`

## Non-Goals

- no real payment systems;
- no real email sending;
- no vendor portal scraping;
- no real credentials;
- no production integrations;
- no persistent database or auth system.

Production integrations should only be added behind explicit adapters, credential boundaries, approval controls, and rollback/compensation design.
