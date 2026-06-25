import { describe, expect, it, beforeEach } from "vitest";
import { createProcurementDemoPurchaseOrder, getPurchaseOrder } from "../src/mock-procurement.js";
import {
  approveAction,
  captureActionIntent,
  generateAuditPacket,
  rejectAction,
  verifyAction,
} from "../src/service.js";
import { resetActionGatewayStore } from "../src/store.js";
import type { ActionType, CreateActionIntentInput } from "../src/types.js";

describe("Action Gateway core service", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("captures high-value purchase orders as high risk and waits for approval", () => {
    const purchaseOrder = createProcurementDemoPurchaseOrder();
    const review = captureActionIntent(purchaseOrderAction(purchaseOrder.id));

    expect(review.action.status).toBe("NEEDS_REVIEW");
    expect(review.riskAssessment.riskLevel).toBe("HIGH");
    expect(review.riskAssessment.requiresHumanApproval).toBe(true);
    expect(review.riskAssessment.reasons).toContain("Purchase orders over $1,000 require human approval.");
    expect(review.approvalRequest?.status).toBe("PENDING");
    expect(getPurchaseOrder(purchaseOrder.id)?.status).toBe("DRAFT");
  });

  it("mock-executes only after approval and verifies expected local ERP state", () => {
    const purchaseOrder = createProcurementDemoPurchaseOrder();
    const review = captureActionIntent(purchaseOrderAction(purchaseOrder.id));

    const approved = approveAction(review.action.id, "manager@example.local", "Looks correct.");
    const updatedPurchaseOrder = getPurchaseOrder(purchaseOrder.id);

    expect(updatedPurchaseOrder?.status).toBe("SUBMITTED");
    expect(updatedPurchaseOrder?.actionIntentId).toBe(review.action.id);
    expect(approved.action.status).toBe("VERIFIED");
    expect(approved.verificationResult?.success).toBe(true);
    expect(approved.verificationResult?.verificationMethod).toBe("LOCAL_MOCK_ERP");
  });

  it("rejects without modifying the local mock ERP record", () => {
    const purchaseOrder = createProcurementDemoPurchaseOrder();
    const review = captureActionIntent(purchaseOrderAction(purchaseOrder.id));

    const rejected = rejectAction(review.action.id, "manager@example.local", "Budget hold.");

    expect(rejected.action.status).toBe("REJECTED");
    expect(rejected.approvalRequest?.status).toBe("REJECTED");
    expect(getPurchaseOrder(purchaseOrder.id)?.status).toBe("DRAFT");
    expect(rejected.verificationResult).toBeUndefined();
  });

  it("records clear verification failure details", () => {
    const review = captureActionIntent({
      sourceAgentName: "RecordsAgent",
      actionType: "UPDATE",
      targetSystem: "MockCRM",
      title: "Update account tier",
      description: "Update local mock account tier.",
      businessObjectType: "account",
      businessObjectId: "acct-demo",
      beforeState: { tier: "standard" },
      proposedAfterState: { tier: "enterprise" },
      fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
    });

    const result = verifyAction(review.action.id, { tier: "standard" });

    expect(result.success).toBe(false);
    expect(result.differences).toEqual(['tier: expected "enterprise", observed "standard"']);
  });

  it("generates an audit packet with policy, approval, verification, and safety disclaimer", () => {
    const purchaseOrder = createProcurementDemoPurchaseOrder();
    const review = captureActionIntent(purchaseOrderAction(purchaseOrder.id));
    approveAction(review.action.id);

    const packet = generateAuditPacket(review.action.id);

    expect(packet.demo).toBe(true);
    expect(packet.product).toBe("AgentCert Onegent Runtime");
    expect(packet.triggeredPolicies.map((policy) => policy.id)).toContain("po-over-1000-requires-approval");
    expect(packet.approvalRequest?.status).toBe("APPROVED");
    expect(packet.execution.status).toBe("COMPLETED");
    expect(packet.verificationResult?.success).toBe(true);
    expect(packet.disclaimer).toContain("No real payments");
    expect(packet.auditEvents.map((event) => event.eventType)).toContain("AUDIT_PACKET_GENERATED");
  });

  it("accepts the required action types", () => {
    const actionTypes: ActionType[] = ["SUBMIT", "PAY", "SEND", "UPDATE"];

    for (const actionType of actionTypes) {
      resetActionGatewayStore();
      const review = captureActionIntent({
        sourceAgentName: "DemoAgent",
        actionType,
        targetSystem: "LocalMockSystem",
        title: `${actionType} demo action`,
        description: "Local mock action for type coverage.",
        businessObjectType: "demo_object",
        businessObjectId: `demo-${actionType.toLowerCase()}`,
        amount: actionType === "PAY" ? 25 : undefined,
        recipient: actionType === "SEND" ? "finance@example.local" : undefined,
        beforeState: { status: "DRAFT" },
        proposedAfterState: { status: "DONE" },
        fieldsChanged: [{ field: "status", before: "DRAFT", after: "DONE" }],
      });

      expect(review.action.actionType).toBe(actionType);
    }
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
