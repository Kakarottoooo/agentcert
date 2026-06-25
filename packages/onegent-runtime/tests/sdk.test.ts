import { beforeEach, describe, expect, it } from "vitest";
import { createProcurementDemoPurchaseOrder, getPurchaseOrder } from "../src/mock-procurement.js";
import { createOnegentRuntime } from "../src/sdk.js";
import { resetActionGatewayStore } from "../src/store.js";
import type { CreateActionIntentInput } from "../src/types.js";

describe("Onegent Runtime SDK interface", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("wraps a high-risk action with risk, policy, approval, execution, verification, and audit", () => {
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

    const execution = runtime.executeAfterApproval(review.action);
    const verification = runtime.verifyOutcome(review.action);
    const packet = runtime.writeAuditPacket(review.action);

    expect(execution.status).toBe("COMPLETED");
    expect(getPurchaseOrder(purchaseOrder.id)?.status).toBe("SUBMITTED");
    expect(verification.success).toBe(true);
    expect(packet.verificationResult?.success).toBe(true);
  });

  it("exposes pending approvals before explicit SDK execution", () => {
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
    expect(() => runtime.executeAfterApproval(review.action.id)).toThrow(/approval status is PENDING/);
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
