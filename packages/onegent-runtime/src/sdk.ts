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
  ApprovalAdapter,
  ApprovalRequest,
  AuditStore,
  CreateActionIntentInput,
  LocalActionAdapter,
  PolicyEngine,
  PolicyEvaluation,
  PolicyRule,
  RiskAssessment,
  VerificationResult,
} from "./types.js";

export interface OnegentRuntimeOptions {
  policyRules?: PolicyRule[];
  policyEngine?: PolicyEngine;
  approvalAdapter?: ApprovalAdapter;
  auditStore?: AuditStore;
}

export interface OnegentRuntime {
  captureAction(input: CreateActionIntentInput): ActionReview;
  assessRisk(action: ActionIntent): RiskAssessment;
  evaluatePolicy(action: ActionIntent, risk?: RiskAssessment): PolicyEvaluation;
  requestApproval(action: ActionIntent | string, assignedTo?: string): Promise<ApprovalRequest>;
  approveAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  rejectAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  executeAfterApproval(action: ActionIntent | string, adapter?: LocalActionAdapter): Promise<ActionExecutionSummary>;
  verifyOutcome(action: ActionIntent | string, observedState?: ActionExecutionSummary | Record<string, unknown>): VerificationResult;
  writeAuditPacket(action: ActionIntent | string): Promise<ActionAuditPacket>;
  getActionReview(action: ActionIntent | string): ActionReview;
  listActionReviews(): ActionReview[];
}

export function createOnegentRuntime(options: OnegentRuntimeOptions = {}): OnegentRuntime {
  return {
    captureAction: (input) => captureActionIntent(input, { policyRules: options.policyRules, policyEngine: options.policyEngine }),
    assessRisk: (action) => assessActionRisk(action),
    evaluatePolicy: (action, risk) => {
      const assessment = risk ?? assessActionRisk(action);
      return options.policyEngine?.evaluate(action, assessment, options.policyRules ?? []) ?? evaluatePolicyRules(action, assessment, options.policyRules);
    },
    requestApproval: async (action, assignedTo) => {
      const id = actionId(action);
      const approval = requestActionApproval(id, assignedTo);
      if (!options.approvalAdapter) return approval;

      const review = getActionReview(id);
      const policy =
        options.policyEngine?.evaluate(review.action, review.riskAssessment, options.policyRules ?? []) ??
        evaluatePolicyRules(review.action, review.riskAssessment, options.policyRules);
      const decision = await options.approvalAdapter.requestApproval({
        action: review.action,
        risk: review.riskAssessment,
        policy,
        approvalRequest: approval,
      });
      if (decision?.approved === true) {
        approveAction(id, decision.reviewerId ?? options.approvalAdapter.name, decision.reviewerComment, { autoExecute: false });
      } else if (decision?.approved === false) {
        rejectAction(id, decision.reviewerId ?? options.approvalAdapter.name, decision.reviewerComment);
      }
      return getActionReview(id).approvalRequest ?? approval;
    },
    approveAction: (action, reviewerId, reviewerComment) =>
      approveAction(actionId(action), reviewerId, reviewerComment, { autoExecute: false }),
    rejectAction: (action, reviewerId, reviewerComment) => rejectAction(actionId(action), reviewerId, reviewerComment),
    executeAfterApproval: async (action, adapter) =>
      adapter ? executeAfterApprovalWithAdapter(actionId(action), adapter) : executeApprovedAction(actionId(action)),
    verifyOutcome: (action, observedState) => verifyActionOutcome(actionId(action), observedStateForVerification(observedState)),
    writeAuditPacket: async (action) => {
      const packet = generateAuditPacket(actionId(action));
      await options.auditStore?.writeAuditPacket(packet);
      return packet;
    },
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
