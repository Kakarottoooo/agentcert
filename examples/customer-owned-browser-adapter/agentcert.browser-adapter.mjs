import { createCustomerOwnedBrowserAdapterKit } from "agentcert/browser-adapter-kit";

// Safe starter: local synthetic sandbox state. Never point v0.1 at production.
const WRITE_SECRET = process.env.BROWSER_SANDBOX_WRITE_KEY ?? "synthetic-write-credential";
const READ_SECRET = process.env.BROWSER_SANDBOX_READ_KEY ?? "synthetic-read-credential";
let state = { status: "DRAFT", reference: "ORDER-DEMO-1" };
const audit = [];
const parametersDigest = "fixture-parameters-sha256";

export const browserAdapterKit = createCustomerOwnedBrowserAdapterKit({
  name: "customer-browser-sandbox",
  targetSystem: "CustomerBrowserSandbox",
  allowedOrigins: ["https://sandbox.example.test"],
  allowedActionTypes: ["SUBMIT"],
  allowedOperation: "order.submit",
  allowedResource: "order:ORDER-DEMO-1",
  sandbox: true,
  resolveWriteCredential() {
    return { reference: "secret-provider://browser/write", secret: WRITE_SECRET, expiresAt: futureExpiry() };
  },
  resolveReadCredential() {
    return { reference: "secret-provider://browser/read", secret: READ_SECRET, expiresAt: futureExpiry() };
  },
  execute({ action, context, credential }) {
    if (credential !== WRITE_SECRET) throw new Error("Write credential boundary failed.");
    const previousState = structuredClone(state);
    state = structuredClone(action.proposedAfterState);
    audit.splice(0, audit.length, {
      targetEventId: "audit-1", actionId: action.id, executionSessionId: context.idempotencyKey,
      occurredAt: new Date().toISOString(), operation: "order.submit", resource: "order:ORDER-DEMO-1",
      parametersDigest, credentialReferenceDigest: "write-reference-digest",
    });
    return { method: "LOCAL_ADAPTER", targetSystem: action.targetSystem, previousState, observedState: structuredClone(state) };
  },
  observe({ credential }) {
    if (credential !== READ_SECRET) throw new Error("Read credential boundary failed.");
    return { observationId: "observation-1", observedAt: new Date().toISOString(), observedState: structuredClone(state), source: "customer-sandbox-read-api" };
  },
  listAuditEvents({ credential }) {
    if (credential !== READ_SECRET) throw new Error("Audit credential boundary failed.");
    return structuredClone(audit);
  },
  revokeWriteCredential() {},
});

export const browserAdapterFixture = {
  action: {
    id: "action-demo-1", idempotencyKey: "adapter-demo-1", workspaceId: "local", workflowId: "browser-adapter-conformance",
    sourceAgentName: "customer-browser-agent", principal: { id: "customer-browser-agent", type: "agent", version: "1.0.0" },
    requestedPermissions: ["order.submit"], actionType: "SUBMIT", targetSystem: "CustomerBrowserSandbox",
    targetUrl: "https://sandbox.example.test/orders/ORDER-DEMO-1", environment: "staging", title: "Submit sandbox order",
    description: "Conformance-only synthetic order submission.", businessObjectType: "order", businessObjectId: "ORDER-DEMO-1",
    beforeState: { status: "DRAFT", reference: "ORDER-DEMO-1" }, proposedAfterState: { status: "SUBMITTED", reference: "ORDER-DEMO-1" },
    fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }], createdAt: new Date().toISOString(), status: "APPROVED",
  },
  expectedObservedState: { status: "SUBMITTED", reference: "ORDER-DEMO-1" },
  expectedAudit: { operation: "order.submit", resource: "order:ORDER-DEMO-1", parametersDigest },
  forbiddenSecrets: [WRITE_SECRET, READ_SECRET],
};

function futureExpiry() { return new Date(Date.now() + 10 * 60_000).toISOString(); }
