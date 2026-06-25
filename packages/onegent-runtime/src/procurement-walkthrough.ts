import { createProcurementDemoPurchaseOrder, PROCUREMENT_DEMO_PO_ID } from "./mock-procurement.js";
import { resetActionGatewayStore, store } from "./store.js";
import { approveAction, captureActionIntent, generateAuditPacket, getActionReview } from "./service.js";
import type { ProcurementWalkthroughState } from "./types.js";

export function resetProcurementWalkthrough(): ProcurementWalkthroughState {
  resetActionGatewayStore();
  const purchaseOrder = createProcurementDemoPurchaseOrder();
  const review = captureActionIntent({
    sourceAgentName: "ProcurementAgent",
    sourceAgentRunId: "procurement-demo-run",
    actionType: "SUBMIT",
    targetSystem: "MockERP",
    environment: "demo",
    title: "Submit purchase order to Acme Industrial Supply",
    description: "Submit a $4,850 purchase order after policy and human approval checks.",
    businessObjectType: "purchase_order",
    businessObjectId: purchaseOrder.id,
    amount: purchaseOrder.amount,
    currency: purchaseOrder.currency,
    vendorName: purchaseOrder.vendor,
    beforeState: {
      id: purchaseOrder.id,
      vendor: purchaseOrder.vendor,
      amount: purchaseOrder.amount,
      currency: purchaseOrder.currency,
      status: "DRAFT",
    },
    proposedAfterState: {
      id: purchaseOrder.id,
      vendor: purchaseOrder.vendor,
      amount: purchaseOrder.amount,
      currency: purchaseOrder.currency,
      status: "SUBMITTED",
    },
    fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }],
    rawAgentReasoningSummary:
      "ProcurementAgent found the PO ready for vendor submission and proposed changing it from DRAFT to SUBMITTED.",
  });

  return { purchaseOrder, review };
}

export function getProcurementWalkthroughState(): ProcurementWalkthroughState {
  if (store.purchaseOrders.size === 0 || store.actions.size === 0) {
    return resetProcurementWalkthrough();
  }

  const purchaseOrder = store.purchaseOrders.get(PROCUREMENT_DEMO_PO_ID);
  const actionId = [...store.actions.keys()][0];
  if (!purchaseOrder || !actionId) {
    return resetProcurementWalkthrough();
  }

  return {
    purchaseOrder,
    review: getActionReview(actionId),
  };
}

export function approveProcurementWalkthrough(): ProcurementWalkthroughState {
  const state = getProcurementWalkthroughState();
  const review = approveAction(
    state.review.action.id,
    "procurement-manager@example.local",
    "Approved for local mock ERP submission.",
  );
  const purchaseOrder = store.purchaseOrders.get(PROCUREMENT_DEMO_PO_ID);
  if (!purchaseOrder) {
    throw new Error("Procurement demo purchase order was not found after approval.");
  }

  return {
    purchaseOrder,
    review,
    auditPacket: generateAuditPacket(review.action.id),
  };
}
