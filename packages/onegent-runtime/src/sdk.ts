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
  recordRollback,
  requestApproval as requestActionApproval,
  verifyOutcome as verifyActionOutcome,
} from "./service.js";
import type {
  ActionAuditPacket,
  ActionExecutionSummary,
  ActionExecutionReceipt,
  ActionIntent,
  ActionReview,
  ApprovalAdapter,
  ApprovalRequest,
  AuditStore,
  AuthorizationPolicy,
  CreateActionIntentInput,
  LocalActionAdapter,
  ExecutionStore,
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
  authorizationPolicy?: AuthorizationPolicy;
  executionStore?: ExecutionStore;
}

export interface OnegentRuntime {
  captureAction(input: CreateActionIntentInput): ActionReview;
  assessRisk(action: ActionIntent): RiskAssessment;
  evaluatePolicy(action: ActionIntent, risk?: RiskAssessment): PolicyEvaluation;
  requestApproval(action: ActionIntent | string, assignedTo?: string): Promise<ApprovalRequest>;
  approveAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  rejectAction(action: ActionIntent | string, reviewerId?: string, reviewerComment?: string): ActionReview;
  executeAfterApproval(action: ActionIntent | string, adapter?: LocalActionAdapter): Promise<ActionExecutionSummary>;
  rollbackAfterExecution(action: ActionIntent | string, adapter: LocalActionAdapter, reason: string): Promise<ActionExecutionReceipt>;
  getExecutionReceipt(action: ActionIntent | string): Promise<ActionExecutionReceipt | undefined>;
  verifyOutcome(action: ActionIntent | string, observedState?: ActionExecutionSummary | Record<string, unknown>, method?: import("./types.js").VerificationMethod): VerificationResult;
  writeAuditPacket(action: ActionIntent | string): Promise<ActionAuditPacket>;
  getActionReview(action: ActionIntent | string): ActionReview;
  listActionReviews(): ActionReview[];
}

export function createOnegentRuntime(options: OnegentRuntimeOptions = {}): OnegentRuntime {
  const executionStore = options.executionStore ?? createInMemoryExecutionStore();
  const inFlight = new Map<string, Promise<ActionExecutionSummary>>();

  const executeOnce = async (actionInput: ActionIntent | string, adapter?: LocalActionAdapter): Promise<ActionExecutionSummary> => {
    const review = getActionReview(actionId(actionInput));
    const key = review.action.idempotencyKey;
    const existing = await executionStore.get(key);
    if (existing) {
      if (existing.actionIntentId !== review.action.id) throw new Error(`Idempotency key ${key} is already bound to another action.`);
      if (existing.status !== "COMPLETED") {
        throw new Error(`Action ${review.action.id} execution is ${existing.status} and cannot be replayed as completed.`);
      }
      return existing.execution;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const execution = adapter
        ? await executeAfterApprovalWithAdapter(review.action.id, adapter, { idempotencyKey: key, attempt: 1 })
        : executeApprovedAction(review.action.id);
      await executionStore.put({
        idempotencyKey: key,
        actionIntentId: review.action.id,
        adapterName: adapter?.name ?? "onegent-local-mock",
        status: "COMPLETED",
        execution,
        rollbackToken: execution.rollbackToken,
        executedAt: new Date().toISOString(),
      });
      return execution;
    })();
    inFlight.set(key, operation);
    try { return await operation; }
    finally { inFlight.delete(key); }
  };

  return {
    captureAction: (input) => captureActionIntent(input, {
      policyRules: options.policyRules,
      policyEngine: options.policyEngine,
      authorizationPolicy: options.authorizationPolicy,
    }),
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
      if (decision?.approved !== undefined && !decision.reviewerId?.trim()) {
        throw new Error(`Approval adapter ${options.approvalAdapter.name} must identify the reviewer.`);
      }
      if (decision?.expiresAt && Date.parse(decision.expiresAt) <= Date.now()) {
        throw new Error(`Approval decision ${decision.decisionId ?? "from adapter"} has expired.`);
      }
      if (decision?.approved === true) {
        approveAction(id, decision.reviewerId!, decision.reviewerComment, { autoExecute: false });
      } else if (decision?.approved === false) {
        rejectAction(id, decision.reviewerId!, decision.reviewerComment);
      }
      return getActionReview(id).approvalRequest ?? approval;
    },
    approveAction: (action, reviewerId, reviewerComment) =>
      approveAction(actionId(action), reviewerId, reviewerComment, { autoExecute: false }),
    rejectAction: (action, reviewerId, reviewerComment) => rejectAction(actionId(action), reviewerId, reviewerComment),
    executeAfterApproval: executeOnce,
    rollbackAfterExecution: async (actionInput, adapter, reason) => {
      const review = getActionReview(actionId(actionInput));
      const key = review.action.idempotencyKey;
      const receipt = await executionStore.get(key);
      if (!receipt || receipt.actionIntentId !== review.action.id) throw new Error(`Action ${review.action.id} has no completed execution to roll back.`);
      if (receipt.status === "ROLLED_BACK") return receipt;
      if (!adapter.rollback) throw new Error(`Adapter ${adapter.name} does not implement the rollback contract.`);
      const result = await adapter.rollback(review.action, receipt.execution, { idempotencyKey: key, reason, rollbackToken: receipt.rollbackToken });
      recordRollback(review.action.id, adapter.name, reason, result);
      const next: ActionExecutionReceipt = {
        ...receipt,
        status: result.success ? "ROLLED_BACK" : "ROLLBACK_FAILED",
        rollback: { ...result, attemptedAt: new Date().toISOString(), reason },
      };
      await executionStore.put(next);
      return next;
    },
    getExecutionReceipt: async (actionInput) => executionStore.get(getActionReview(actionId(actionInput)).action.idempotencyKey),
    verifyOutcome: (action, observedState, method) => verifyActionOutcome(actionId(action), observedStateForVerification(observedState), method),
    writeAuditPacket: async (action) => {
      const packet = generateAuditPacket(actionId(action));
      await options.auditStore?.writeAuditPacket(packet);
      return packet;
    },
    getActionReview: (action) => getActionReview(actionId(action)),
    listActionReviews: () => listActionReviews(),
  };
}

export function createInMemoryExecutionStore(name = "in-memory-execution-store"): ExecutionStore & {
  receipts: Map<string, ActionExecutionReceipt>;
} {
  const receipts = new Map<string, ActionExecutionReceipt>();
  return {
    name,
    receipts,
    get: (idempotencyKey) => receipts.get(idempotencyKey),
    put: (receipt) => { receipts.set(receipt.idempotencyKey, receipt); },
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
