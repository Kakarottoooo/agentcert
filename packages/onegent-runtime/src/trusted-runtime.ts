import type {
  ActionAuditPacket,
  ActionExecutionSummary,
  ActionIntent,
  ActionReview,
  ApprovalRequest,
  AuditStore,
  VerificationResult,
} from "./types.js";
import type { OnegentRuntime, OnegentRuntimeOptions } from "./sdk.js";
import { createOnegentRuntime } from "./sdk.js";
import { assessEvidenceStrength } from "./evidence-strength.js";
import { assertMandateAuthorizesAction, verifyActionMandate } from "./mandates.js";
import { canonicalJson, sha256 } from "./trust-crypto.js";
import type {
  ActionMandate,
  ControlledActionAdapter,
  IndependentOutcomeProbe,
  MandateStore,
  OutcomeObservation,
  TrustedActionEvidence,
  TrustedCaptureInput,
} from "./trust-types.js";
import type { TrustedActionRecorder } from "./trusted-recorder.js";
import { isRegisteredControlledActionAdapter, isRegisteredIndependentOutcomeProbe } from "./controlled-adapter.js";

export interface TrustedActionRuntimeOptions {
  recorder: TrustedActionRecorder;
  mandateStore: MandateStore;
  mandatePublicKeys: Record<string, string>;
  outcomeProbe: IndependentOutcomeProbe;
  runtime?: Omit<OnegentRuntimeOptions, "auditStore">;
  auditStore?: AuditStore;
  now?: () => Date;
}

export interface TrustedExecutionResult {
  execution: ActionExecutionSummary;
  observation: OutcomeObservation;
  verification: VerificationResult;
}

export interface TrustedActionRuntime {
  startRun(payload?: Record<string, unknown>): Promise<void>;
  captureAction(input: TrustedCaptureInput): Promise<ActionReview>;
  requestApproval(action: ActionIntent | string, assignedTo?: string): Promise<ApprovalRequest>;
  approveAction(action: ActionIntent | string, reviewerId: string, comment?: string): Promise<ActionReview>;
  rejectAction(action: ActionIntent | string, reviewerId: string, comment?: string): Promise<ActionReview>;
  executeAndVerify(action: ActionIntent | string, adapter: ControlledActionAdapter): Promise<TrustedExecutionResult>;
  finalize(action: ActionIntent | string): Promise<ActionAuditPacket & { trustedActionEvidence: TrustedActionEvidence }>;
  getActionReview(action: ActionIntent | string): ActionReview;
}

interface TrustedActionState {
  mandate: ActionMandate;
  mandateVerified: boolean;
  adapterControlled: boolean;
  observation?: OutcomeObservation;
  verification?: VerificationResult;
}

export function createTrustedActionRuntime(options: TrustedActionRuntimeOptions): TrustedActionRuntime {
  if (!isRegisteredIndependentOutcomeProbe(options.outcomeProbe)) {
    throw new Error(`Outcome probe ${options.outcomeProbe.name} is not a registered AgentCert independent probe capability.`);
  }
  const base: OnegentRuntime = createOnegentRuntime(options.runtime);
  const states = new Map<string, TrustedActionState>();
  const now = options.now ?? (() => new Date());

  return {
    startRun: async (payload = {}) => {
      await options.recorder.start({
        protocol: "agentcert.action_assurance.v0.1",
        evidenceStrengthModel: "agentcert.evidence_strength.v0.1",
        ...bounded(payload),
      });
    },
    captureAction: async ({ action: input, mandateId }) => {
      const mandate = await options.mandateStore.get(mandateId);
      if (!mandate) throw new Error(`Mandate ${mandateId} was not found.`);
      const publicKey = options.mandatePublicKeys[mandate.sourceSignature.keyId];
      if (!publicKey) throw new Error(`No trusted public key is configured for mandate key ${mandate.sourceSignature.keyId}.`);
      const verification = verifyActionMandate(mandate, publicKey, now());
      if (!verification.valid) throw new Error(`Mandate ${mandateId} is invalid: ${verification.errors.join(" ")}`);
      const actionInput = {
        ...input,
        mandateId,
        principal: input.principal ?? { id: mandate.subject.principalId, type: "agent" as const, version: mandate.subject.agentVersion },
      };
      assertMandateAuthorizesAction(mandate, actionInput);
      await options.recorder.append("MANDATE_BOUND", {
        mandateId,
        mandateDigestSha256: mandate.digestSha256,
        principalId: mandate.subject.principalId,
        policySha256: mandate.policySha256,
      });
      const review = base.captureAction(actionInput);
      states.set(review.action.id, { mandate, mandateVerified: true, adapterControlled: false });
      await options.recorder.append("ACTION_CAPTURED", actionRecordPayload(review.action));
      return review;
    },
    requestApproval: async (actionInput, assignedTo) => {
      const action = requireTrustedAction(base, states, actionInput);
      const approval = await base.requestApproval(action, assignedTo);
      await options.recorder.append("APPROVAL_REQUESTED", {
        actionId: action.id,
        approvalRequestId: approval.id,
        assignedTo: approval.assignedTo,
      });
      return approval;
    },
    approveAction: async (actionInput, reviewerId, comment) => {
      const action = requireTrustedAction(base, states, actionInput);
      if (!reviewerId.trim()) throw new Error("A human reviewer identity is required.");
      if (reviewerId === action.principal.id) throw new Error("The action principal cannot approve its own action.");
      const review = base.approveAction(action, reviewerId, comment);
      await options.recorder.append("ACTION_APPROVED", {
        actionId: action.id,
        reviewerId,
        approvalRequestId: review.approvalRequest?.id,
      });
      return review;
    },
    rejectAction: async (actionInput, reviewerId, comment) => {
      const action = requireTrustedAction(base, states, actionInput);
      if (!reviewerId.trim()) throw new Error("A human reviewer identity is required.");
      const review = base.rejectAction(action, reviewerId, comment);
      await options.recorder.append("ACTION_REJECTED", { actionId: action.id, reviewerId });
      return review;
    },
    executeAndVerify: async (actionInput, adapter) => {
      const action = requireTrustedAction(base, states, actionInput);
      const state = states.get(action.id)!;
      assertControlledAdapter(adapter, action);
      assertMandateAuthorizesAction(state.mandate, action);
      if (options.outcomeProbe.name === adapter.name) throw new Error("Outcome probe must use a separate read path from the execution adapter.");
      await options.recorder.append("EXECUTION_STARTED", {
        actionId: action.id,
        adapter: adapter.name,
        boundary: adapter.control,
      });
      const execution = await base.executeAfterApproval(action, adapter);
      state.adapterControlled = true;
      await options.recorder.append("EXECUTION_COMPLETED", {
        actionId: action.id,
        adapter: adapter.name,
        observedStateSha256: sha256(canonicalJson(execution.observedState ?? {})),
      });
      const observation = await options.outcomeProbe.observe(action, execution);
      state.observation = structuredClone(observation);
      await options.recorder.append("OUTCOME_OBSERVED", {
        actionId: action.id,
        observationId: observation.observationId,
        source: observation.source,
        observedAt: observation.observedAt,
        observedStateSha256: sha256(canonicalJson(observation.observedState)),
      });
      const verification = base.verifyOutcome(action, observation.observedState, "INDEPENDENT_PROBE");
      state.verification = verification;
      await options.recorder.append(verification.success ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED", {
        actionId: action.id,
        verificationId: verification.id,
        differences: verification.differences,
      });
      return { execution, observation: structuredClone(observation), verification };
    },
    finalize: async (actionInput) => {
      const action = requireTrustedAction(base, states, actionInput);
      const state = states.get(action.id)!;
      const packet = await base.writeAuditPacket(action);
      await options.recorder.complete({
        actionId: action.id,
        actionStatus: base.getActionReview(action).action.status,
        auditPacketSha256: sha256(canonicalJson(packet)),
      });
      const journal = options.recorder.validation();
      const evidenceStrength = assessEvidenceStrength({
        journal,
        mandateVerified: state.mandateVerified,
        adapterControlled: state.adapterControlled,
        outcomeVerified: state.verification?.success === true && Boolean(state.observation),
      });
      const runReceipt = options.recorder.createReceipt({
        mandateDigests: [state.mandate.digestSha256],
        actionIds: [action.id],
        evidenceStrength,
      });
      const trustedActionEvidence: TrustedActionEvidence = {
        schemaVersion: "agentcert.trusted_action_evidence.v0.1",
        mandate: state.mandate,
        runReceipt,
        outcomeObservation: state.observation,
        verification: state.verification,
        evidenceStrength,
      };
      const enriched = { ...packet, trustedActionEvidence };
      await options.auditStore?.writeAuditPacket(enriched);
      return enriched;
    },
    getActionReview: (actionInput) => base.getActionReview(actionId(actionInput)),
  };
}

function requireTrustedAction(base: OnegentRuntime, states: Map<string, TrustedActionState>, input: ActionIntent | string): ActionIntent {
  const action = base.getActionReview(actionId(input)).action;
  if (!states.has(action.id) || !action.mandateId) throw new Error(`Action ${action.id} is not bound to a trusted mandate.`);
  return action;
}

function assertControlledAdapter(adapter: ControlledActionAdapter, action: ActionIntent): void {
  if (!isRegisteredControlledActionAdapter(adapter)) {
    throw new Error(`Adapter ${adapter.name} is not a registered AgentCert controlled adapter capability.`);
  }
  const control = adapter.control;
  if (!control || control.mode !== "agentcert_gateway" || control.credentials !== "gateway_managed"
    || control.bypassPrevention !== "credentials_unavailable_to_agent") {
    throw new Error(`Adapter ${adapter.name} does not provide the required AgentCert credential-isolated gateway boundary.`);
  }
  if (!control.allowedActionTypes.includes(action.actionType)) throw new Error(`Adapter ${adapter.name} does not allow ${action.actionType}.`);
  if (!control.allowedTargetSystems.includes(action.targetSystem)) throw new Error(`Adapter ${adapter.name} does not allow ${action.targetSystem}.`);
}

function actionRecordPayload(action: ActionIntent): Record<string, unknown> {
  return {
    actionId: action.id,
    mandateId: action.mandateId,
    principalId: action.principal.id,
    principalVersion: action.principal.version,
    actionType: action.actionType,
    targetSystem: action.targetSystem,
    businessObjectType: action.businessObjectType,
    businessObjectId: action.businessObjectId,
    requestedPermissions: action.requestedPermissions,
    expectedStateSha256: sha256(canonicalJson(action.proposedAfterState)),
  };
}

function actionId(value: ActionIntent | string): string {
  return typeof value === "string" ? value : value.id;
}

function bounded(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > 16_384) throw new Error("Trusted run metadata cannot exceed 16 KiB.");
  return structuredClone(value);
}
