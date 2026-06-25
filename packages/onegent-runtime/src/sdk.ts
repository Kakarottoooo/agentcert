import { evaluatePolicy as evaluatePolicyRules } from "./policies.js";
import { assessRisk as assessActionRisk } from "./risk.js";
import {
  approveAction,
  captureActionIntent,
  executeAfterApproval as executeApprovedAction,
  executeAfterApprovalWithAdapter,
  generateAuditPacket,
  getActionReview,
  listActionReviews,
  rejectAction,
  requestApproval as requestActionApproval,
  verifyOutcome as verifyActionOutcome,
} from "./service.js";
import type {
  ActionAuditPacket,
  ActionExecutionSummary,
  ActionIntent,
  ActionReview,
  ApprovalRequest,
  CreateActionIntentInput,
  LocalActionAdapter,
  PolicyEvaluation,
  PolicyRule,
  RiskAssessment,
  VerificationResult,
} from "./types.js";

export interface OnegentRuntimeOptions {
  policyRules?: PolicyRule[];
}

export interface OnegentRuntime {
  captureAction(input: CreateActionIntentInput): ActionReview;
  assessRisk(action: ActionIntent): RiskAssessment;
  evaluatePolicy(action: ActionIntent, risk?: RiskAssessment): PolicyEvaluation;
  requestApproval(action: ActionIntent | string, assignedTo?: string): ApprovalRequest;
  approveAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  rejectAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  executeAfterApproval(action: ActionIntent | string, adapter?: LocalActionAdapter): Promise<ActionExecutionSummary>;
  verifyOutcome(action: ActionIntent | string, observedState?: ActionExecutionSummary | Record<string, unknown>): VerificationResult;
  writeAuditPacket(action: ActionIntent | string): ActionAuditPacket;
  getActionReview(action: ActionIntent | string): ActionReview;
  listActionReviews(): ActionReview[];
}

export function createOnegentRuntime(options: OnegentRuntimeOptions = {}): OnegentRuntime {
  return {
    captureAction: (input) => captureActionIntent(input, { policyRules: options.policyRules }),
    assessRisk: (action) => assessActionRisk(action),
    evaluatePolicy: (action, risk) => evaluatePolicyRules(action, risk ?? assessActionRisk(action), options.policyRules),
    requestApproval: (action, assignedTo) => requestActionApproval(actionId(action), assignedTo),
    approveAction: (action, reviewerId, reviewerComment) =>
      approveAction(actionId(action), reviewerId, reviewerComment, { autoExecute: false }),
    rejectAction: (action, reviewerId, reviewerComment) => rejectAction(actionId(action), reviewerId, reviewerComment),
    executeAfterApproval: async (action, adapter) =>
      adapter ? executeAfterApprovalWithAdapter(actionId(action), adapter) : executeApprovedAction(actionId(action)),
    verifyOutcome: (action, observedState) => verifyActionOutcome(actionId(action), observedStateForVerification(observedState)),
    writeAuditPacket: (action) => generateAuditPacket(actionId(action)),
    getActionReview: (action) => getActionReview(actionId(action)),
    listActionReviews: () => listActionReviews(),
  };
}

function actionId(action: ActionIntent | string): string {
  return typeof action === "string" ? action : action.id;
}

function observedStateForVerification(input: ActionExecutionSummary | Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  if (isActionExecutionSummary(input)) {
    return input.observedState;
  }
  return input as Record<string, unknown>;
}

function isActionExecutionSummary(input: ActionExecutionSummary | Record<string, unknown>): input is ActionExecutionSummary {
  return typeof input.method === "string" && typeof input.status === "string" && typeof input.targetSystem === "string";
}
