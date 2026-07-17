# AgentCert Controlled Action Runtime

The controlled action runtime is the production action-boundary layer in AgentCert. `packages/onegent-runtime` remains the internal source module name, while external users install the single public `agentcert-sdk` package.

Unlike MCPBench and Tripwire CI, it does not ask whether an agent should ship. It asks whether one live action should be allowed right now.

## Implemented MVP

- receives proposed actions from an agent or tool gateway;
- supports `SUBMIT`, `PAY`, `SEND`, and `UPDATE` action intents;
- classifies action risk;
- records the acting principal and requested permissions;
- supports a deterministic authorization policy that denies missing scopes;
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

Install the public SDK:

```bash
npm install agentcert-sdk
```

```ts
import {
  createInMemoryAuditStore,
  createLocalEchoAdapter,
  createAgentCertRuntime,
} from "agentcert-sdk/runtime";

const auditStore = createInMemoryAuditStore();
const runtime = createAgentCertRuntime({
  authorizationPolicy: {
    name: "procurement-permissions",
    authorize: (action) => ({
      allowed: action.principal.id === "procurement-agent",
      grantedPermissions: ["MockERP:SUBMIT"],
      policyVersion: "2026-07-14",
      reason: "The procurement agent may submit local mock purchase orders.",
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
  principal: { id: "procurement-agent", type: "agent", owner: "procurement@example.local" },
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

The intended integration points are:

- `assessRisk(action)`;
- `evaluatePolicy(action)`;
- `requestApproval(action)`;
- `executeAfterApproval(action, adapter?)`;
- `verifyOutcome(action, observed)`;
- `writeAuditPacket(action)`.

The checked-in adapter path is local and deterministic:

- `createLocalEchoAdapter()` returns the proposed after-state as observed local state.
- `createInMemoryAuditStore()` captures audit packets for tests and demos.
- `approvalAdapter.requestApproval()` lets callers plug in their own ticket, Slack, email, or human review system later without changing the core runtime API.
- `authorizationPolicy.authorize()` binds the action to a principal and grants
  explicit permissions. If any requested permission is absent, the action is
  cancelled before approval or execution.

Real systems should only be added behind explicit credential, approval,
rollback, verification, and audit boundaries.

## Sandbox Certification Harness

Onegent now includes a tenant-scoped, local-only certification harness between
the mock demo and any future vendor sandbox. It enforces synthetic seed data,
deny-by-default network access, target allowlists, explicit idempotency keys,
identified approval, per-action and per-run limits, global and tenant kill
switches, observed-state verification, rollback, and deterministic reset.

```bash
npm run onegent:sandbox-certify
```

The active suite emits a versioned report covering ten controls. See
[Sandbox Certification Harness v0.1](sandbox-certification-harness.md) for the
SDK, control table, schema, and customer-sandbox progression.

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
