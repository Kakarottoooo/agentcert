import { DEFAULT_POLICY_RULES, evaluatePolicy, getPolicyRules } from "./policies.js";
import { assessRisk } from "./risk.js";
import { nextId, nowIso, store } from "./store.js";
import { getPurchaseOrder, submitMockPurchaseOrder } from "./mock-procurement.js";
import type {
  ActionAuditPacket,
  ActionExecutionSummary,
  ActionIntent,
  ActionReview,
  ApprovalRequest,
  AuditEvent,
  AuditEventType,
  CreateActionIntentInput,
  LocalActionAdapter,
  PolicyEngine,
  PolicyRule,
  VerificationMethod,
  VerificationResult,
} from "./types.js";

export interface ActionGatewayOptions {
  policyRules?: PolicyRule[];
  policyEngine?: PolicyEngine;
}

export interface ApprovalOptions {
  autoExecute?: boolean;
}

export function captureActionIntent(input: CreateActionIntentInput, options: ActionGatewayOptions = {}): ActionReview {
  const action: ActionIntent = {
    id: nextId("act"),
    workspaceId: input.workspaceId ?? "demo-workspace",
    workflowId: input.workflowId ?? "demo-workflow",
    sourceAgentName: input.sourceAgentName,
    sourceAgentRunId: input.sourceAgentRunId,
    actionType: input.actionType,
    targetSystem: input.targetSystem,
    targetUrl: input.targetUrl,
    environment: input.environment ?? "demo",
    title: input.title,
    description: input.description,
    businessObjectType: input.businessObjectType,
    businessObjectId: input.businessObjectId,
    amount: input.amount,
    currency: input.currency,
    recipient: input.recipient,
    vendorName: input.vendorName,
    beforeState: input.beforeState ?? {},
    proposedAfterState: input.proposedAfterState ?? {},
    fieldsChanged: input.fieldsChanged ?? [],
    rawAgentReasoningSummary: input.rawAgentReasoningSummary,
    createdAt: nowIso(),
    status: "CAPTURED",
  };

  store.actions.set(action.id, action);
  appendAudit(action.id, "ACTION_CAPTURED", "AGENT", action.sourceAgentName, "Action intent captured from agent.", {
    actionType: action.actionType,
    targetSystem: action.targetSystem,
  });

  const risk = assessRisk(action);
  store.riskAssessments.set(action.id, risk);
  appendAudit(action.id, "RISK_ASSESSED", "SYSTEM", "onegent-runtime", "Risk assessment completed.", {
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
  });

  const configuredRules = options.policyRules ?? DEFAULT_POLICY_RULES;
  const policy = options.policyEngine?.evaluate(action, risk, configuredRules) ?? evaluatePolicy(action, risk, options.policyRules);
  store.policyRulesByAction.set(
    action.id,
    getPolicyRules(policy.triggeredPolicies, configuredRules === DEFAULT_POLICY_RULES ? DEFAULT_POLICY_RULES : [...configuredRules, ...DEFAULT_POLICY_RULES]),
  );
  appendAudit(action.id, "POLICY_EVALUATED", "SYSTEM", "onegent-runtime", "Policy evaluation completed.", {
    effect: policy.effect,
    triggeredPolicies: policy.triggeredPolicies,
  });

  if (policy.blocked) {
    action.status = "CANCELLED";
    store.actions.set(action.id, action);
    return getActionReview(action.id);
  }

  if (policy.requiresHumanApproval) {
    action.status = "NEEDS_REVIEW";
    store.actions.set(action.id, action);
    const approvalRequest: ApprovalRequest = {
      id: nextId("approval"),
      actionIntentId: action.id,
      riskAssessmentId: risk.id,
      requestedBy: action.sourceAgentName,
      assignedTo: "human-approver@example.local",
      status: "PENDING",
      createdAt: nowIso(),
    };
    store.approvals.set(action.id, approvalRequest);
    appendAudit(action.id, "APPROVAL_REQUESTED", "SYSTEM", "onegent-runtime", "Human approval requested.", {
      assignedTo: approvalRequest.assignedTo,
    });
    return getActionReview(action.id);
  }

  executeMockAction(action.id);
  verifyAction(action.id);
  return getActionReview(action.id);
}

export function approveAction(
  actionId: string,
  reviewerId = "human-approver@example.local",
  reviewerComment = "Approved for local demo execution.",
  options: ApprovalOptions = {},
): ActionReview {
  const action = requireAction(actionId);
  const approval = requireApproval(actionId);

  if (approval.status !== "PENDING") {
    throw new Error(`Action ${actionId} does not have a pending approval request.`);
  }

  approval.status = "APPROVED";
  approval.reviewedAt = nowIso();
  approval.reviewerComment = reviewerComment;
  store.approvals.set(actionId, approval);

  action.status = "APPROVED";
  store.actions.set(actionId, action);
  appendAudit(action.id, "ACTION_APPROVED", "HUMAN", reviewerId, "Human approver approved the action.", {
    reviewerComment,
  });

  if (options.autoExecute ?? true) {
    executeMockAction(action.id);
    verifyAction(action.id);
  }
  return getActionReview(action.id);
}

export function requestApproval(
  actionId: string,
  assignedTo = "human-approver@example.local",
  requestedBy = "onegent-runtime",
): ApprovalRequest {
  const action = requireAction(actionId);
  const existingApproval = store.approvals.get(actionId);
  if (existingApproval) {
    return existingApproval;
  }
  if (action.status === "REJECTED" || action.status === "EXECUTED" || action.status === "VERIFIED") {
    throw new Error(`Action ${actionId} cannot request approval from status ${action.status}.`);
  }
  const risk = store.riskAssessments.get(actionId) ?? assessRisk(action);
  store.riskAssessments.set(actionId, risk);
  const approvalRequest: ApprovalRequest = {
    id: nextId("approval"),
    actionIntentId: action.id,
    riskAssessmentId: risk.id,
    requestedBy,
    assignedTo,
    status: "PENDING",
    createdAt: nowIso(),
  };
  action.status = "NEEDS_REVIEW";
  store.actions.set(action.id, action);
  store.approvals.set(action.id, approvalRequest);
  appendAudit(action.id, "APPROVAL_REQUESTED", "SYSTEM", "onegent-runtime", "Human approval requested.", {
    assignedTo: approvalRequest.assignedTo,
  });
  return approvalRequest;
}

export function rejectAction(
  actionId: string,
  reviewerId = "human-approver@example.local",
  reviewerComment = "Rejected by human approver.",
): ActionReview {
  const action = requireAction(actionId);
  const approval = requireApproval(actionId);

  if (approval.status !== "PENDING") {
    throw new Error(`Action ${actionId} does not have a pending approval request.`);
  }

  approval.status = "REJECTED";
  approval.reviewedAt = nowIso();
  approval.reviewerComment = reviewerComment;
  store.approvals.set(actionId, approval);

  action.status = "REJECTED";
  store.actions.set(action.id, action);
  appendAudit(action.id, "ACTION_REJECTED", "HUMAN", reviewerId, "Human approver rejected the action.", {
    reviewerComment,
  });
  return getActionReview(action.id);
}

export function executeAfterApproval(actionId: string): ActionExecutionSummary {
  const action = requireAction(actionId);
  const approval = store.approvals.get(actionId);
  assertExecutableAfterApproval(action, approval);
  if (action.status === "EXECUTED" || action.status === "VERIFIED" || action.status === "FAILED_VERIFICATION") {
    return buildExecutionSummary(action);
  }
  return executeMockAction(actionId);
}

export async function executeAfterApprovalWithAdapter(
  actionId: string,
  adapter: LocalActionAdapter,
): Promise<ActionExecutionSummary> {
  const action = requireAction(actionId);
  const approval = store.approvals.get(actionId);
  assertExecutableAfterApproval(action, approval);
  if (action.status === "EXECUTED" || action.status === "VERIFIED" || action.status === "FAILED_VERIFICATION") {
    return buildExecutionSummary(action);
  }

  appendAudit(action.id, "MOCK_EXECUTION_STARTED", "SYSTEM", "onegent-runtime", "Local adapter execution started.", {
    adapter: adapter.name,
    targetSystem: action.targetSystem,
  });
  const result = await adapter.execute(action);
  action.status = "EXECUTED";
  store.actions.set(action.id, action);
  appendAudit(action.id, "MOCK_EXECUTION_COMPLETED", "SYSTEM", "onegent-runtime", "Local adapter execution completed.", {
    adapter: adapter.name,
    method: result.method ?? "LOCAL_ADAPTER",
    observedState: result.observedState,
  });

  return {
    method: result.method ?? "LOCAL_ADAPTER",
    status: "COMPLETED",
    targetSystem: result.targetSystem ?? action.targetSystem,
    previousState: result.previousState ?? action.beforeState,
    observedState: result.observedState,
  };
}

export function executeMockAction(actionId: string): ActionExecutionSummary {
  const action = requireAction(actionId);

  if (action.status === "NEEDS_REVIEW") {
    throw new Error(`Action ${actionId} requires human approval before execution.`);
  }

  appendAudit(action.id, "MOCK_EXECUTION_STARTED", "SYSTEM", "onegent-runtime", "Local mock execution started.", {
    targetSystem: action.targetSystem,
  });

  let observedState = action.proposedAfterState;
  let previousState = action.beforeState;
  let method: ActionExecutionSummary["method"] = "MOCK";

  if (
    action.actionType === "SUBMIT" &&
    action.businessObjectType === "purchase_order" &&
    action.targetSystem === "MockERP"
  ) {
    const previousPurchaseOrder = getPurchaseOrder(action.businessObjectId);
    previousState = previousPurchaseOrder ? purchaseOrderState(previousPurchaseOrder) : action.beforeState;
    const updatedPurchaseOrder = submitMockPurchaseOrder(action);
    observedState = purchaseOrderState(updatedPurchaseOrder);
    method = "LOCAL_MOCK_ERP";
  }

  action.status = "EXECUTED";
  store.actions.set(action.id, action);
  appendAudit(action.id, "MOCK_EXECUTION_COMPLETED", "SYSTEM", "onegent-runtime", "Local mock execution completed.", {
    method,
    observedState,
  });

  return {
    method,
    status: "COMPLETED",
    targetSystem: action.targetSystem,
    previousState,
    observedState,
  };
}

export function verifyOutcome(actionId: string, observedState?: Record<string, unknown>): VerificationResult {
  return verifyAction(actionId, observedState);
}

export function verifyAction(actionId: string, observedState?: Record<string, unknown>): VerificationResult {
  const action = requireAction(actionId);
  if (action.status !== "EXECUTED" && action.status !== "VERIFIED" && action.status !== "FAILED_VERIFICATION") {
    throw new Error(`Action ${actionId} must be mock-executed before verification.`);
  }

  const effectiveObservedState = observedState ?? observeActionState(action);
  const differences = diffState(action.proposedAfterState, effectiveObservedState);
  const success = differences.length === 0;
  const method: VerificationMethod =
    action.businessObjectType === "purchase_order" && action.targetSystem === "MockERP" ? "LOCAL_MOCK_ERP" : "MOCK";

  const result: VerificationResult = {
    id: nextId("verify"),
    actionIntentId: action.id,
    expectedState: action.proposedAfterState,
    observedState: effectiveObservedState,
    success,
    differences,
    verificationMethod: method,
    createdAt: nowIso(),
  };

  store.verifications.set(action.id, result);
  action.status = success ? "VERIFIED" : "FAILED_VERIFICATION";
  store.actions.set(action.id, action);
  appendAudit(
    action.id,
    success ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
    "SYSTEM",
    "onegent-runtime",
    success ? "Observed state matched expected state." : "Observed state did not match expected state.",
    { differences },
  );

  return result;
}

export function getActionReview(actionId: string): ActionReview {
  const action = requireAction(actionId);
  const riskAssessment = store.riskAssessments.get(actionId);
  if (!riskAssessment) {
    throw new Error(`Risk assessment for action ${actionId} was not found.`);
  }

  const approvalRequest = store.approvals.get(actionId);
  const verificationResult = store.verifications.get(actionId);
  const auditEvents = store.auditEvents.filter((event) => event.actionIntentId === actionId);
  const policyRules = store.policyRulesByAction.get(actionId) ?? getPolicyRules(riskAssessment.triggeredPolicies);

  return {
    action,
    riskAssessment,
    approvalRequest,
    verificationResult,
    auditEvents,
    policyRules,
    blocked: action.status === "CANCELLED",
  };
}

export function listActionReviews(): ActionReview[] {
  return [...store.actions.keys()].map((actionId) => getActionReview(actionId));
}

export function writeAuditPacket(actionId: string): ActionAuditPacket {
  return generateAuditPacket(actionId);
}

export function generateAuditPacket(actionId: string): ActionAuditPacket {
  const review = getActionReview(actionId);
  const execution = buildExecutionSummary(review.action);

  appendAudit(
    actionId,
    "AUDIT_PACKET_GENERATED",
    "SYSTEM",
    "onegent-runtime",
    "Audit packet generated for customer demo.",
  );

  const refreshedReview = getActionReview(actionId);
  return {
    demo: true,
    product: "AgentCert Onegent Runtime",
    scenario: "Procurement purchase-order approval walkthrough",
    actionIntent: refreshedReview.action,
    riskAssessment: refreshedReview.riskAssessment,
    triggeredPolicies: refreshedReview.policyRules,
    approvalRequest: refreshedReview.approvalRequest,
    execution,
    verificationResult: refreshedReview.verificationResult,
    auditEvents: refreshedReview.auditEvents,
    disclaimer:
      "Local demo only. No real payments, emails, vendor portals, credentials, or production systems are used.",
  };
}

function observeActionState(action: ActionIntent): Record<string, unknown> {
  if (
    action.businessObjectType === "purchase_order" &&
    action.targetSystem === "MockERP" &&
    action.businessObjectId.length > 0
  ) {
    const purchaseOrder = getPurchaseOrder(action.businessObjectId);
    if (purchaseOrder) {
      return purchaseOrderState(purchaseOrder);
    }
  }

  return action.status === "EXECUTED" ? action.proposedAfterState : action.beforeState;
}

function purchaseOrderState(purchaseOrder: {
  id: string;
  vendor: string;
  amount: number;
  currency: string;
  status: string;
}): Record<string, unknown> {
  return {
    id: purchaseOrder.id,
    vendor: purchaseOrder.vendor,
    amount: purchaseOrder.amount,
    currency: purchaseOrder.currency,
    status: purchaseOrder.status,
  };
}

function diffState(expected: Record<string, unknown>, observed: Record<string, unknown>): string[] {
  const differences: string[] = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const observedValue = observed[key];
    if (JSON.stringify(expectedValue) !== JSON.stringify(observedValue)) {
      differences.push(`${key}: expected ${JSON.stringify(expectedValue)}, observed ${JSON.stringify(observedValue)}`);
    }
  }
  return differences;
}

function buildExecutionSummary(action: ActionIntent): ActionExecutionSummary {
  const verification = store.verifications.get(action.id);
  const method =
    action.businessObjectType === "purchase_order" && action.targetSystem === "MockERP" ? "LOCAL_MOCK_ERP" : "MOCK";
  return {
    method,
    status: action.status === "VERIFIED" || action.status === "FAILED_VERIFICATION" ? "COMPLETED" : "NOT_EXECUTED",
    targetSystem: action.targetSystem,
    previousState: action.beforeState,
    observedState: verification?.observedState,
  };
}

function assertExecutableAfterApproval(action: ActionIntent, approval: ApprovalRequest | undefined): void {
  if (approval && approval.status !== "APPROVED") {
    throw new Error(`Action ${action.id} cannot execute while approval status is ${approval.status}.`);
  }
  if (action.status === "REJECTED" || action.status === "CANCELLED") {
    throw new Error(`Action ${action.id} cannot execute from status ${action.status}.`);
  }
}

function appendAudit(
  actionIntentId: string,
  eventType: AuditEventType,
  actorType: AuditEvent["actorType"],
  actorId: string,
  message: string,
  metadata?: Record<string, unknown>,
): AuditEvent {
  const event: AuditEvent = {
    id: nextId("audit"),
    actionIntentId,
    eventType,
    actorType,
    actorId,
    message,
    metadata,
    createdAt: nowIso(),
  };
  store.auditEvents.push(event);
  return event;
}

function requireAction(actionId: string): ActionIntent {
  const action = store.actions.get(actionId);
  if (!action) {
    throw new Error(`Action ${actionId} was not found.`);
  }
  return action;
}

function requireApproval(actionId: string): ApprovalRequest {
  const approval = store.approvals.get(actionId);
  if (!approval) {
    throw new Error(`Approval request for action ${actionId} was not found.`);
  }
  return approval;
}
