import { beforeEach, describe, expect, it } from "vitest";
import {
  approveProcurementWalkthrough,
  getProcurementWalkthroughState,
  resetProcurementWalkthrough,
} from "../src/procurement-walkthrough.js";
import { resetActionGatewayStore } from "../src/store.js";

describe("procurement walkthrough", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("starts with a high-risk approval request and draft mock purchase order", () => {
    const state = resetProcurementWalkthrough();

    expect(state.purchaseOrder.vendor).toBe("Acme Industrial Supply");
    expect(state.purchaseOrder.amount).toBe(4_850);
    expect(state.purchaseOrder.status).toBe("DRAFT");
    expect(state.review.action.sourceAgentName).toBe("ProcurementAgent");
    expect(state.review.action.status).toBe("NEEDS_REVIEW");
    expect(state.review.riskAssessment.riskLevel).toBe("HIGH");
  });

  it("approves, submits, verifies, and exports an audit packet", () => {
    resetProcurementWalkthrough();

    const state = approveProcurementWalkthrough();

    expect(state.purchaseOrder.status).toBe("SUBMITTED");
    expect(state.review.action.status).toBe("VERIFIED");
    expect(state.review.verificationResult?.success).toBe(true);
    expect(state.auditPacket?.execution.method).toBe("LOCAL_MOCK_ERP");
    expect(state.auditPacket?.auditEvents.map((event) => event.eventType)).toContain("AUDIT_PACKET_GENERATED");
  });

  it("reuses the current walkthrough state after initialization", () => {
    const initialState = resetProcurementWalkthrough();
    const readState = getProcurementWalkthroughState();

    expect(readState.review.action.id).toBe(initialState.review.action.id);
    expect(readState.purchaseOrder.id).toBe(initialState.purchaseOrder.id);
  });
});
