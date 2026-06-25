import { beforeEach, describe, expect, it } from "vitest";
import { handleActionGatewayRequest } from "../src/api.js";
import { resetActionGatewayStore } from "../src/store.js";

describe("Action Gateway local API routes", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("exposes procurement demo reset, approve, mock ERP page, and audit packet routes", () => {
    const reset = handleActionGatewayRequest({
      method: "POST",
      path: "/api/action-gateway/demo/procurement/reset",
    });

    expect(reset.status).toBe(200);
    const resetBody = reset.body as { review: { action: { id: string; status: string } } };
    expect(resetBody.review.action.status).toBe("NEEDS_REVIEW");

    const approved = handleActionGatewayRequest({
      method: "POST",
      path: "/api/action-gateway/demo/procurement/approve",
    });
    expect(approved.status).toBe(200);
    const approvedBody = approved.body as { purchaseOrder: { status: string }; review: { action: { status: string } } };
    expect(approvedBody.purchaseOrder.status).toBe("SUBMITTED");
    expect(approvedBody.review.action.status).toBe("VERIFIED");

    const auditPacket = handleActionGatewayRequest({
      method: "GET",
      path: `/api/action-gateway/actions/${resetBody.review.action.id}/audit-packet`,
    });
    expect(auditPacket.status).toBe(200);
    expect(auditPacket.contentType).toContain("application/json");

    const mockPage = handleActionGatewayRequest({
      method: "GET",
      path: "/mock-systems/procurement/purchase-orders/PO-DEMO-4850",
    });
    expect(mockPage.status).toBe(200);
    expect(mockPage.contentType).toContain("text/html");
    expect(String(mockPage.body)).toContain("SUBMITTED");
  });

  it("returns a route-level error instead of silently executing rejected actions", () => {
    const reset = handleActionGatewayRequest({
      method: "POST",
      path: "/api/action-gateway/demo/procurement/reset",
    });
    const actionId = (reset.body as { review: { action: { id: string } } }).review.action.id;

    const rejected = handleActionGatewayRequest({
      method: "POST",
      path: `/api/action-gateway/actions/${actionId}/reject`,
      body: { reviewerComment: "Not approved." },
    });
    expect(rejected.status).toBe(200);

    const secondApproval = handleActionGatewayRequest({
      method: "POST",
      path: `/api/action-gateway/actions/${actionId}/approve`,
    });

    expect(secondApproval.status).toBe(400);
    expect(secondApproval.body).toEqual({
      error: `Action ${actionId} does not have a pending approval request.`,
    });
  });

  it("does not verify a high-risk action before approval and mock execution", () => {
    const reset = handleActionGatewayRequest({
      method: "POST",
      path: "/api/action-gateway/demo/procurement/reset",
    });
    const actionId = (reset.body as { review: { action: { id: string } } }).review.action.id;

    const verification = handleActionGatewayRequest({
      method: "POST",
      path: `/api/action-gateway/actions/${actionId}/verify`,
      body: { observedState: { status: "SUBMITTED" } },
    });

    expect(verification.status).toBe(400);
    expect(verification.body).toEqual({
      error: `Action ${actionId} must be mock-executed before verification.`,
    });
  });
});
