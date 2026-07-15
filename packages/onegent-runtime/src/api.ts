import { approveProcurementWalkthrough, getProcurementWalkthroughState, resetProcurementWalkthrough } from "./procurement-walkthrough.js";
import {
  approveAction,
  captureActionIntent,
  generateAuditPacket,
  getActionReview,
  listActionReviews,
  rejectAction,
  verifyAction,
} from "./service.js";
import { getPurchaseOrder } from "./mock-procurement.js";
import { renderProcurementWalkthroughHtml, renderPurchaseOrderHtml } from "./ui.js";
import type { AuthorizationPolicy, CreateActionIntentInput, PolicyRule } from "./types.js";

export interface ActionGatewayRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ActionGatewayApiOptions {
  policyRules?: PolicyRule[];
  authorizationPolicy?: AuthorizationPolicy;
}

export interface ActionGatewayResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export function handleActionGatewayRequest(
  request: ActionGatewayRequest,
  options: ActionGatewayApiOptions = {},
): ActionGatewayResponse {
  const method = request.method.toUpperCase();
  const pathname = new URL(request.path, "http://agentcert.local").pathname;
  const segments = pathname.split("/").filter(Boolean);

  try {
    if (method === "GET" && pathname === "/api/action-gateway/actions") {
      return json(200, { actions: listActionReviews() });
    }

    if (method === "POST" && pathname === "/api/action-gateway/actions") {
      return json(201, captureActionIntent(request.body as CreateActionIntentInput, options));
    }

    if (segments[0] === "api" && segments[1] === "action-gateway" && segments[2] === "actions") {
      return handleActionRoute(method, segments, request.body);
    }

    if (method === "GET" && pathname === "/api/action-gateway/demo/procurement") {
      return json(200, getProcurementWalkthroughState());
    }

    if (method === "POST" && pathname === "/api/action-gateway/demo/procurement/reset") {
      return json(200, resetProcurementWalkthrough(options.policyRules));
    }

    if (method === "POST" && pathname === "/api/action-gateway/demo/procurement/approve") {
      return json(200, approveProcurementWalkthrough());
    }

    if (method === "GET" && pathname === "/action-gateway/walkthrough/procurement") {
      return html(200, renderProcurementWalkthroughHtml(getProcurementWalkthroughState()));
    }

    if (
      method === "GET" &&
      segments[0] === "mock-systems" &&
      segments[1] === "procurement" &&
      segments[2] === "purchase-orders" &&
      segments[3]
    ) {
      const purchaseOrder = getPurchaseOrder(segments[3]);
      if (!purchaseOrder) {
        return json(404, { error: `Purchase order ${segments[3]} was not found.` });
      }
      return html(200, renderPurchaseOrderHtml(purchaseOrder));
    }

    return json(404, { error: `Route ${method} ${pathname} was not found.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Action Gateway error.";
    return json(400, { error: message });
  }
}

function handleActionRoute(method: string, segments: string[], body: unknown): ActionGatewayResponse {
  const actionId = segments[3];
  const childRoute = segments[4];

  if (!actionId) {
    return json(404, { error: "Action id is required." });
  }

  if (method === "GET" && !childRoute) {
    return json(200, getActionReview(actionId));
  }

  if (method === "POST" && childRoute === "approve") {
    const parsedBody = parseObject(body);
    return json(
      200,
      approveAction(
        actionId,
        stringField(parsedBody, "reviewerId") ?? "human-approver@example.local",
        stringField(parsedBody, "reviewerComment") ?? "Approved for local demo execution.",
      ),
    );
  }

  if (method === "POST" && childRoute === "reject") {
    const parsedBody = parseObject(body);
    return json(
      200,
      rejectAction(
        actionId,
        stringField(parsedBody, "reviewerId") ?? "human-approver@example.local",
        stringField(parsedBody, "reviewerComment") ?? "Rejected by human approver.",
      ),
    );
  }

  if (method === "POST" && childRoute === "verify") {
    const parsedBody = parseObject(body);
    const observedState = parseObject(parsedBody.observedState);
    return json(200, verifyAction(actionId, Object.keys(observedState).length > 0 ? observedState : undefined));
  }

  if (method === "GET" && childRoute === "audit-packet") {
    return json(200, generateAuditPacket(actionId));
  }

  return json(404, { error: `Action route ${segments.join("/")} was not found.` });
}

function json(status: number, body: unknown): ActionGatewayResponse {
  return { status, body, contentType: "application/json; charset=utf-8" };
}

function html(status: number, body: string): ActionGatewayResponse {
  return { status, body, contentType: "text/html; charset=utf-8" };
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
