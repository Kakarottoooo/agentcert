import { beforeEach, describe, expect, it } from "vitest";
import { createProcurementDemoPurchaseOrder, getPurchaseOrder } from "../src/mock-procurement.js";
import { createOnegentRuntime } from "../src/sdk.js";
import { resetActionGatewayStore } from "../src/store.js";
import type { CreateActionIntentInput } from "../src/types.js";

describe("Onegent Runtime SDK interface", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("wraps a high-risk action with risk, policy, approval, execution, verification, and audit", async () => {
    const runtime = createOnegentRuntime();
    const purchaseOrder = createProcurementDemoPurchaseOrder();
    const review = runtime.captureAction(purchaseOrderAction(purchaseOrder.id));

    const risk = runtime.assessRisk(review.action);
    const policy = runtime.evaluatePolicy(review.action, risk);

    expect(risk.riskLevel).toBe("HIGH");
    expect(policy.requiresHumanApproval).toBe(true);
    expect(review.approvalRequest?.status).toBe("PENDING");

    const approved = runtime.approveAction(review.action, "manager@example.local", "Approved through SDK.");

    expect(approved.action.status).toBe("APPROVED");
    expect(getPurchaseOrder(purchaseOrder.id)?.status).toBe("DRAFT");

    const execution = await runtime.executeAfterApproval(review.action);
    const verification = runtime.verifyOutcome(review.action);
    const packet = runtime.writeAuditPacket(review.action);

    expect(execution.status).toBe("COMPLETED");
    expect(getPurchaseOrder(purchaseOrder.id)?.status).toBe("SUBMITTED");
    expect(verification.success).toBe(true);
    expect(packet.verificationResult?.success).toBe(true);
  });

  it("exposes pending approvals before explicit SDK execution", async () => {
    const runtime = createOnegentRuntime({
      policyRules: [
        {
          id: "updates-require-approval",
          name: "Updates require approval",
          description: "All update actions require review in this SDK test.",
          actionTypes: ["UPDATE"],
          effect: "REQUIRE_APPROVAL",
          enabled: true,
        },
      ],
    });
    const review = runtime.captureAction({
      sourceAgentName: "CRM Agent",
      actionType: "UPDATE",
      targetSystem: "MockCRM",
      title: "Update account tier",
      description: "Local mock update.",
      businessObjectType: "account",
      businessObjectId: "acct-1",
      beforeState: { tier: "standard" },
      proposedAfterState: { tier: "enterprise" },
      fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
    });

    const approval = runtime.requestApproval(review.action.id, "ops@example.local");

    expect(approval.assignedTo).toBe(review.approvalRequest?.assignedTo);
    expect(approval.status).toBe("PENDING");
    await expect(runtime.executeAfterApproval(review.action.id)).rejects.toThrow(/approval status is PENDING/);
  });

  it("executes approved actions through a local adapter and verifies the observed state", async () => {
    const runtime = createOnegentRuntime({
      policyRules: [
        {
          id: "send-requires-approval",
          name: "Send requires approval",
          description: "Outbound send actions require local review in SDK tests.",
          actionTypes: ["SEND"],
          effect: "REQUIRE_APPROVAL",
          enabled: true,
        },
      ],
    });
    const review = runtime.captureAction({
      sourceAgentName: "SupportAgent",
      actionType: "SEND",
      targetSystem: "LocalOutbox",
      title: "Send customer update",
      description: "Write a local mock outbound message.",
      businessObjectType: "message",
      businessObjectId: "msg-1",
      recipient: "customer@example.local",
      beforeState: { status: "DRAFT" },
      proposedAfterState: { status: "SENT", recipient: "customer@example.local" },
      fieldsChanged: [{ field: "status", before: "DRAFT", after: "SENT" }],
    });
    runtime.approveAction(review.action, "ops@example.local", "Approved local adapter execution.");

    const execution = await runtime.executeAfterApproval(review.action, {
      name: "local-outbox-adapter",
      execute: (action) => ({
        method: "LOCAL_ADAPTER",
        previousState: action.beforeState,
        observedState: { status: "SENT", recipient: action.recipient },
      }),
    });
    const verification = runtime.verifyOutcome(review.action, execution);
    const audit = runtime.writeAuditPacket(review.action);

    expect(execution).toMatchObject({ method: "LOCAL_ADAPTER", status: "COMPLETED" });
    expect(verification.success).toBe(true);
    expect(audit.auditEvents.map((event) => event.message)).toContain("Local adapter execution completed.");
  });
});

function purchaseOrderAction(purchaseOrderId: string): CreateActionIntentInput {
  return {
    sourceAgentName: "ProcurementAgent",
    sourceAgentRunId: "procurement-demo-run",
    actionType: "SUBMIT",
    targetSystem: "MockERP",
    environment: "demo",
    title: "Submit purchase order to Acme Industrial Supply",
    description: "Submit a local mock purchase order.",
    businessObjectType: "purchase_order",
    businessObjectId: purchaseOrderId,
    amount: 4_850,
    currency: "USD",
    vendorName: "Acme Industrial Supply",
    beforeState: {
      id: purchaseOrderId,
      vendor: "Acme Industrial Supply",
      amount: 4_850,
      currency: "USD",
      status: "DRAFT",
    },
    proposedAfterState: {
      id: purchaseOrderId,
      vendor: "Acme Industrial Supply",
      amount: 4_850,
      currency: "USD",
      status: "SUBMITTED",
    },
    fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }],
  };
}
