import type { ActionIntent, MockPurchaseOrder } from "./types.js";
import { nowIso, store } from "./store.js";

export const PROCUREMENT_DEMO_PO_ID = "PO-DEMO-4850";

export function createProcurementDemoPurchaseOrder(): MockPurchaseOrder {
  const purchaseOrder: MockPurchaseOrder = {
    id: PROCUREMENT_DEMO_PO_ID,
    vendor: "Acme Industrial Supply",
    amount: 4_850,
    currency: "USD",
    status: "DRAFT",
    vendorApproved: true,
    lineItem: "Replacement conveyor motor assembly",
    lastUpdatedAt: nowIso(),
  };

  store.purchaseOrders.set(purchaseOrder.id, purchaseOrder);
  return purchaseOrder;
}

export function getPurchaseOrder(id: string): MockPurchaseOrder | undefined {
  return store.purchaseOrders.get(id);
}

export function submitMockPurchaseOrder(action: ActionIntent): MockPurchaseOrder {
  const purchaseOrder = store.purchaseOrders.get(action.businessObjectId);
  if (!purchaseOrder) {
    throw new Error(`Mock purchase order ${action.businessObjectId} was not found.`);
  }

  const updated: MockPurchaseOrder = {
    ...purchaseOrder,
    status: "SUBMITTED",
    lastUpdatedAt: nowIso(),
    actionIntentId: action.id,
  };
  store.purchaseOrders.set(updated.id, updated);
  return updated;
}
