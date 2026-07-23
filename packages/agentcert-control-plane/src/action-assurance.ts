import { createHash, randomUUID } from "node:crypto";
import type { ActionRecord, ApprovalRecord, EvidenceRecord } from "./types.js";
import {
  EvidenceSigner,
  canonicalJson,
  verifyCanonicalAttestation,
  type ServerAttestation,
} from "./signing.js";
import { classifyBrowserEnforcement, type BrowserEnforcementEvaluation, type BrowserEnforcementEvidenceBundle, type RuntimeIdentityRecord } from "./browser-enforcement.js";

export const ACTION_MANDATE_VERSION = "agentcert.action_mandate.v0.2" as const;
export const ACTION_ASSURANCE_RECEIPT_VERSION = "agentcert.action_assurance_receipt.v0.1" as const;

export type AssuranceObjectStatus = "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED" | "SUPERSEDED" | "COMPROMISED" | "DISPUTED";
export type IdentityAssuranceLevel = "SELF_ASSERTED" | "EMAIL_VERIFIED" | "OIDC_VERIFIED" | "ORGANIZATION_ATTESTED" | "WORKLOAD_ATTESTED" | "HARDWARE_ATTESTED";
export type EnforcementLevel = "ENFORCED" | "OBSERVED_ONLY" | "SELF_REPORTED";
export type EnforcementMethod = "CREDENTIAL_BROKER" | "NETWORK_PROXY" | "SIGNED_ADAPTER" | "TARGET_SYSTEM_POLICY" | "NONE";
export type ActionEvidenceStrength = "REPORTED" | "RECORDED" | "ENFORCED" | "OUTCOME_VERIFIED" | "INDEPENDENTLY_REVIEWED";
export type OutcomeMethod = "TARGET_API" | "TARGET_UI" | "TARGET_AUDIT_LOG" | "WEBHOOK" | "DATABASE_QUERY" | "THIRD_PARTY_CONFIRMATION" | "AGENT_SELF_REPORT";
export type OutcomeResult = "SATISFIED" | "NOT_SATISFIED" | "PARTIALLY_SATISFIED" | "INCONCLUSIVE" | "NOT_OBSERVED";

export interface MandateConstraints {
  monetaryLimit?: number;
  valueBand?: string;
  timeWindow?: { startsAt: string; endsAt: string };
  rateLimit?: { count: number; periodSeconds: number };
  geographicLimit?: string[];
  counterpartyAllowlist?: string[];
  counterpartyDenylist?: string[];
  resourceLimit?: string[];
  approvalRequirement?: "NONE" | "HUMAN" | "MULTI_PARTY";
  allowedAdapter?: string[];
  allowedEnvironment?: string[];
  dataClassificationLimit?: string;
  rollbackRequired?: boolean;
  outcomePredicateRequirement?: string;
}

export interface ActionMandatePayload {
  schemaVersion: typeof ACTION_MANDATE_VERSION;
  mandateId: string;
  tenantId: string;
  issuerIdentityId: string;
  granteeIdentityId: string;
  parentMandateId?: string;
  audience: string[];
  permittedActionClasses: ActionRecord["actionType"][];
  permittedOperations: string[];
  permittedResources: string[];
  prohibitedOperations: string[];
  constraints: MandateConstraints;
  validFrom: string;
  expiresAt: string;
  maxUses: number;
  maxDelegationDepth: number;
  nonce: string;
  version: number;
  createdAt: string;
}

export interface ActionMandateRecord {
  id: string;
  projectId: string;
  payload: ActionMandatePayload;
  digestSha256: string;
  status: AssuranceObjectStatus;
  attestation?: ServerAttestation;
  createdBy: string;
  createdAt: string;
  statusReason?: string;
  statusChangedBy?: string;
  statusChangedAt?: string;
}

export interface ActionPolicyDecisionRecord {
  id: string;
  projectId: string;
  actionId: string;
  actionDigestSha256: string;
  policyId: string;
  policyVersion: string;
  result: "ALLOW" | "DENY" | "NEEDS_APPROVAL" | "NEEDS_ADDITIONAL_ATTESTATION" | "NEEDS_REDUCED_SCOPE";
  reasonCodes: string[];
  humanReadableExplanation: string;
  obligations: string[];
  requiredApprovers: string[];
  evaluatedContextDigest: string;
  evaluatedAt: string;
  evaluatorIdentity: string;
  attestation?: ServerAttestation;
}

export interface OutcomeAttestationRecord {
  id: string;
  projectId: string;
  actionId: string;
  actionDigestSha256: string;
  predicateId: string;
  predicateVersion: string;
  expectedState: Record<string, unknown>;
  observedState: Record<string, unknown>;
  result: OutcomeResult;
  observationMethod: OutcomeMethod;
  observationSource: string;
  collectorIdentityId?: string;
  collectedAt: string;
  evidenceReferences: string[];
  confidence: number;
  attestation?: ServerAttestation;
}

export interface EnforcementProof {
  level: EnforcementLevel;
  method: EnforcementMethod;
  verified: boolean;
  adapterId?: string;
  executionGrantDigest?: string;
  actionEventChainDigest?: string;
  browserEvaluation?: BrowserEnforcementEvaluation;
  browserEvidence?: BrowserEnforcementEvidenceBundle;
}

export interface ActionAssuranceReceiptCore {
  receiptSchemaVersion: typeof ACTION_ASSURANCE_RECEIPT_VERSION;
  receiptId: string;
  actionId: string;
  tenantReference: string;
  principalIdentity: { id: string; assuranceLevel: IdentityAssuranceLevel };
  agentIdentity: { id: string; version?: string };
  agentBuildIdentity?: { buildId: string; scopeFingerprintSha256?: string };
  executorIdentity: { id: string; assuranceLevel: IdentityAssuranceLevel };
  collectorIdentity: { id: string; assuranceLevel: IdentityAssuranceLevel };
  issuerIdentity: { id: string; keyId?: string };
  mandateChainDigest?: string;
  mandateSummary?: {
    mandateId: string;
    issuerIdentityId: string;
    granteeIdentityId: string;
    permittedActionClasses: ActionRecord["actionType"][];
    permittedResources: string[];
    expiresAt: string;
    status: AssuranceObjectStatus;
  };
  actionIntentDigest: string;
  policyDecision: {
    decisionId: string;
    result: ActionPolicyDecisionRecord["result"];
    policyId: string;
    policyVersion: string;
    reasonCodes: string[];
    actionDigestSha256: string;
  };
  approvals: Array<{
    approvalId: string;
    approverIdentityId: string;
    decision: ApprovalRecord["decision"];
    actionDigestSha256?: string;
    bindingValid: boolean;
    createdAt: string;
  }>;
  executionGrantDigest?: string;
  executionGrantId?: string;
  evidenceStrength: ActionEvidenceStrength;
  enforcementLevel: EnforcementLevel;
  enforcementMethod: EnforcementMethod;
  actionEventChainDigest?: string;
  executionSessionId?: string;
  executionSessionAttestationDigest?: string;
  runtimeIdentity?: { id: string; keyId: string };
  adapterIdentity?: { id: string; version: string };
  credentialIsolationSummary?: { mode: string; leaseId: string; revoked: boolean };
  eventChainFinalHash?: string;
  eventCount?: number;
  outcomeAttestationDigest?: string;
  outcomeObservationMethod?: string;
  outcomeObservationIndependence?: string;
  reconciliationReportDigest?: string;
  reconciliationResult?: string;
  enforcementChecks?: BrowserEnforcementEvaluation["checks"];
  enforcementReasonCodes?: string[];
  assuranceProfile?: string;
  outcomeAttestation?: {
    outcomeAttestationId: string;
    result: OutcomeResult;
    observationMethod: OutcomeMethod;
    observationSource: string;
    actionDigestSha256: string;
    confidence: number;
    collectedAt: string;
  };
  evidenceManifest: Array<{ evidenceId: string; kind: string; sha256: string; sizeBytes: number }>;
  identityAssuranceSummary: {
    principal: IdentityAssuranceLevel;
    agent: IdentityAssuranceLevel;
    executor: IdentityAssuranceLevel;
    collector: IdentityAssuranceLevel;
  };
  facts: {
    directlyObserved: string[];
    thirdPartySigned: string[];
    inferred: string[];
    selfReported: string[];
  };
  controls: { controlled: string[]; notControlled: string[] };
  issuedAt: string;
  validUntil: string;
  currentStatus: AssuranceObjectStatus;
  statusEndpoint?: string;
  warnings: string[];
}

export interface ActionAssuranceReceipt {
  core: ActionAssuranceReceiptCore;
  coreSha256: string;
  signatureSet: ServerAttestation[];
}

export interface ActionAssuranceReceiptRecord {
  id: string;
  projectId: string;
  actionId: string;
  receipt: ActionAssuranceReceipt;
  currentStatus: AssuranceObjectStatus;
  createdAt: string;
}

export interface ReceiptVerificationCheck {
  id: string;
  result: "PASS" | "FAIL" | "WARN" | "NOT_CHECKED";
  reasonCode: string;
  message: string;
}

export interface ReceiptVerificationResult {
  result: "VALID" | "VALID_WITH_WARNINGS" | "REVIEW_REQUIRED" | "INVALID" | "REVOKED" | "DISPUTED" | "INCONCLUSIVE";
  checks: ReceiptVerificationCheck[];
}

export function actionIntentDigest(action: ActionRecord): string {
  return sha256(canonicalJson({
    id: action.id,
    projectId: action.projectId,
    externalId: action.externalId,
    agentId: action.agentId,
    principal: action.principal,
    actionType: action.actionType,
    targetSystem: action.targetSystem,
    requestedPermissions: action.requestedPermissions,
    amount: action.amount,
    currency: action.currency,
    expectedState: action.expectedState,
    createdAt: action.createdAt,
  }));
}

export function actionRequestFingerprint(action: ActionRecord): string {
  return sha256(canonicalJson({
    projectId: action.projectId,
    externalId: action.externalId,
    agentId: action.agentId,
    principal: action.principal,
    actionType: action.actionType,
    targetSystem: action.targetSystem,
    requestedPermissions: action.requestedPermissions,
    amount: action.amount,
    currency: action.currency,
    expectedState: action.expectedState,
    mandateDigestSha256: action.assuranceContext?.mandateDigestSha256,
  }));
}

export function mandateDigest(payload: ActionMandatePayload): string {
  return sha256(canonicalJson(payload));
}

export function validateMandateForAction(mandate: ActionMandateRecord, action: ActionRecord, at = new Date()): string[] {
  const errors: string[] = [];
  if (mandate.projectId !== action.projectId || mandate.payload.tenantId !== action.projectId) errors.push("mandate_tenant_mismatch");
  if (mandate.status !== "ACTIVE") errors.push(`mandate_${mandate.status.toLowerCase()}`);
  if (mandate.digestSha256 !== mandateDigest(mandate.payload)) errors.push("mandate_digest_mismatch");
  const timestamp = at.getTime();
  if (!Number.isFinite(timestamp) || timestamp < Date.parse(mandate.payload.validFrom) || timestamp >= Date.parse(mandate.payload.expiresAt)) errors.push("mandate_not_active");
  if (String(action.principal.id ?? "") !== mandate.payload.granteeIdentityId) errors.push("mandate_grantee_mismatch");
  if (!mandate.payload.audience.includes(action.targetSystem)) errors.push("mandate_audience_mismatch");
  if (!mandate.payload.permittedActionClasses.includes(action.actionType)) errors.push("mandate_action_class_denied");
  const operation = `${action.targetSystem}:${action.actionType}`;
  if (!mandate.payload.permittedOperations.includes(operation) && !mandate.payload.permittedOperations.includes(action.actionType)) errors.push("mandate_operation_denied");
  if (mandate.payload.prohibitedOperations.includes(operation) || mandate.payload.prohibitedOperations.includes(action.actionType)) errors.push("mandate_operation_prohibited");
  if (!mandate.payload.permittedResources.includes(action.targetSystem) && !mandate.payload.permittedResources.includes(`${action.targetSystem}:${action.externalId}`)) errors.push("mandate_resource_denied");
  if (mandate.payload.constraints.monetaryLimit !== undefined && (action.amount === undefined || action.amount > mandate.payload.constraints.monetaryLimit)) errors.push("mandate_monetary_limit_exceeded");
  return errors;
}

export function validateDelegationAttenuation(parent: ActionMandatePayload, child: ActionMandatePayload): string[] {
  const errors: string[] = [];
  if (child.parentMandateId !== parent.mandateId) errors.push("delegation_parent_mismatch");
  if (child.issuerIdentityId !== parent.granteeIdentityId) errors.push("delegation_chain_discontinuous");
  if (!isSubset(child.audience, parent.audience)) errors.push("delegation_audience_expanded");
  if (!isSubset(child.permittedActionClasses, parent.permittedActionClasses)) errors.push("delegation_action_scope_expanded");
  if (!isSubset(child.permittedOperations, parent.permittedOperations)) errors.push("delegation_operation_scope_expanded");
  if (!isSubset(child.permittedResources, parent.permittedResources)) errors.push("delegation_resource_scope_expanded");
  if (Date.parse(child.expiresAt) > Date.parse(parent.expiresAt)) errors.push("delegation_expiry_extended");
  if (child.maxUses > parent.maxUses) errors.push("delegation_uses_expanded");
  if (child.maxDelegationDepth >= parent.maxDelegationDepth) errors.push("delegation_depth_not_attenuated");
  const parentLimit = parent.constraints.monetaryLimit;
  const childLimit = child.constraints.monetaryLimit;
  if (parentLimit !== undefined && (childLimit === undefined || childLimit > parentLimit)) errors.push("delegation_monetary_limit_expanded");
  return errors;
}

export function createActionAssuranceReceipt(input: {
  action: ActionRecord;
  mandate?: ActionMandateRecord;
  policyDecision: ActionPolicyDecisionRecord;
  approvals: ApprovalRecord[];
  outcome?: OutcomeAttestationRecord;
  evidence: EvidenceRecord[];
  enforcementProof?: EnforcementProof;
  issuerId: string;
  signer?: EvidenceSigner;
  validUntil: string;
  statusEndpoint?: string;
  now?: Date;
}): ActionAssuranceReceipt {
  const now = input.now ?? new Date();
  const digest = actionIntentDigest(input.action);
  const mandateErrors = input.mandate ? validateMandateForAction(input.mandate, input.action, now) : ["mandate_missing"];
  const approvalBindings = input.approvals.map((approval) => ({
    approvalId: approval.id,
    approverIdentityId: approval.reviewerId,
    decision: approval.decision,
    actionDigestSha256: approval.actionDigestSha256,
    bindingValid: approval.actionDigestSha256 === digest,
    createdAt: approval.createdAt,
  }));
  const requestedProof = input.enforcementProof;
  const browserEvaluation = requestedProof?.browserEvaluation;
  const browserEvidence = requestedProof?.browserEvidence;
  const enforcementValid = Boolean(
    requestedProof?.verified
    && requestedProof.level === "ENFORCED"
    && requestedProof.method !== "NONE"
    && requestedProof.executionGrantDigest
    && browserEvaluation?.enforcementLevel === "ENFORCED"
    && browserEvaluation.assuranceProfile === "BROWSER_ENFORCED_V0_2"
    && browserEvaluation.checks.every((item) => item.result === "PASS")
    && browserEvidence,
  );
  const recordingValid = Boolean(requestedProof?.verified && requestedProof.actionEventChainDigest);
  const outcomeProvenanceVerified = Boolean(enforcementValid || (input.outcome?.attestation && input.outcome.observationMethod !== "AGENT_SELF_REPORT"));
  const enforcementLevel: EnforcementLevel = enforcementValid
    ? "ENFORCED"
    : outcomeProvenanceVerified ? "OBSERVED_ONLY" : "SELF_REPORTED";
  const enforcementMethod: EnforcementMethod = enforcementValid ? requestedProof!.method : "NONE";
  const evidenceStrength: ActionEvidenceStrength = enforcementValid
    ? "ENFORCED"
    : outcomeProvenanceVerified ? "OUTCOME_VERIFIED" : recordingValid ? "RECORDED" : "REPORTED";
  const warnings = [...mandateErrors, ...(browserEvaluation?.reasonCodes ?? [])];
  if (!enforcementValid) warnings.push("execution_boundary_not_verified");
  if (approvalBindings.some((approval) => !approval.bindingValid)) warnings.push("approval_not_bound_to_action_digest");
  if (!enforcementValid) {
    if (!input.outcome) warnings.push("outcome_not_observed");
    else if (input.outcome.actionDigestSha256 !== digest) warnings.push("outcome_action_digest_mismatch");
    else if (input.outcome.observationMethod === "AGENT_SELF_REPORT") warnings.push("outcome_agent_self_reported");
    else if (!outcomeProvenanceVerified) warnings.push("outcome_provenance_unverified");
  }
  if (!input.signer) warnings.push("receipt_not_server_attested");
  const principalId = String(input.action.principal.id ?? "unknown-principal");
  const principalAssurance: IdentityAssuranceLevel = "SELF_ASSERTED";
  const collectorAssurance: IdentityAssuranceLevel = enforcementValid || input.outcome?.attestation ? "WORKLOAD_ATTESTED" : "SELF_ASSERTED";
  const core: ActionAssuranceReceiptCore = {
    receiptSchemaVersion: ACTION_ASSURANCE_RECEIPT_VERSION,
    receiptId: randomUUID(),
    actionId: input.action.id,
    tenantReference: input.action.projectId,
    principalIdentity: { id: principalId, assuranceLevel: principalAssurance },
    agentIdentity: { id: input.action.agentId ?? principalId, version: optionalString(input.action.principal.version) },
    executorIdentity: { id: requestedProof?.adapterId ?? "unbound-executor", assuranceLevel: enforcementValid ? "WORKLOAD_ATTESTED" : "SELF_ASSERTED" },
    collectorIdentity: { id: enforcementValid ? browserEvidence!.outcomeAttestation.payload.collectorIdentityId : input.outcome?.collectorIdentityId ?? "unbound-collector", assuranceLevel: collectorAssurance },
    issuerIdentity: { id: input.issuerId, keyId: input.signer?.keyId },
    mandateChainDigest: input.mandate?.digestSha256,
    mandateSummary: input.mandate ? {
      mandateId: input.mandate.payload.mandateId,
      issuerIdentityId: input.mandate.payload.issuerIdentityId,
      granteeIdentityId: input.mandate.payload.granteeIdentityId,
      permittedActionClasses: input.mandate.payload.permittedActionClasses,
      permittedResources: input.mandate.payload.permittedResources,
      expiresAt: input.mandate.payload.expiresAt,
      status: input.mandate.status,
    } : undefined,
    actionIntentDigest: digest,
    policyDecision: {
      decisionId: input.policyDecision.id,
      result: input.policyDecision.result,
      policyId: input.policyDecision.policyId,
      policyVersion: input.policyDecision.policyVersion,
      reasonCodes: input.policyDecision.reasonCodes,
      actionDigestSha256: input.policyDecision.actionDigestSha256,
    },
    approvals: approvalBindings,
    executionGrantDigest: enforcementValid ? requestedProof?.executionGrantDigest : undefined,
    executionGrantId: enforcementValid ? browserEvidence?.executionGrant.payload.executionGrantId : undefined,
    evidenceStrength,
    enforcementLevel,
    enforcementMethod,
    actionEventChainDigest: enforcementValid ? requestedProof?.actionEventChainDigest : undefined,
    executionSessionId: enforcementValid ? browserEvidence?.executionSession.payload.executionSessionId : undefined,
    executionSessionAttestationDigest: enforcementValid ? browserEvidence?.executionSession.payloadSha256 : undefined,
    runtimeIdentity: enforcementValid ? { id: browserEvidence!.executionSession.payload.runtimeIdentityId, keyId: browserEvidence!.executionSession.payload.runtimeKeyId } : undefined,
    adapterIdentity: enforcementValid ? { id: browserEvidence!.executionSession.payload.adapterId, version: browserEvidence!.executionSession.payload.adapterVersion } : undefined,
    credentialIsolationSummary: enforcementValid ? { mode: browserEvidence!.credentialLease.isolationMode, leaseId: browserEvidence!.credentialLease.credentialLeaseId, revoked: browserEvidence!.credentialLease.status === "REVOKED" } : undefined,
    eventChainFinalHash: enforcementValid ? browserEvidence?.eventCheckpoint.payload.finalEventHash : undefined,
    eventCount: enforcementValid ? browserEvidence?.eventCheckpoint.payload.eventCount : undefined,
    outcomeAttestationDigest: enforcementValid ? browserEvidence?.outcomeAttestation.payloadSha256 : undefined,
    outcomeObservationMethod: enforcementValid ? browserEvidence?.outcomeAttestation.payload.observationMethod : undefined,
    outcomeObservationIndependence: enforcementValid ? browserEvidence?.outcomeAttestation.payload.observationIndependence : undefined,
    reconciliationReportDigest: enforcementValid ? browserEvidence?.reconciliationReport.payloadSha256 : undefined,
    reconciliationResult: enforcementValid ? browserEvidence?.reconciliationReport.payload.result : undefined,
    enforcementChecks: browserEvaluation?.checks,
    enforcementReasonCodes: browserEvaluation?.reasonCodes,
    assuranceProfile: browserEvaluation?.assuranceProfile,
    outcomeAttestation: enforcementValid ? {
      outcomeAttestationId: browserEvidence!.outcomeAttestation.payload.outcomeAttestationId,
      result: browserEvidence!.outcomeAttestation.payload.result,
      observationMethod: browserEvidence!.outcomeAttestation.payload.observationMethod,
      observationSource: browserEvidence!.outcomeAttestation.payload.observationSource,
      actionDigestSha256: digest,
      confidence: browserEvidence!.outcomeAttestation.payload.confidence,
      collectedAt: browserEvidence!.outcomeAttestation.payload.collectedAt,
    } : input.outcome ? {
      outcomeAttestationId: input.outcome.id,
      result: input.outcome.result,
      observationMethod: input.outcome.observationMethod,
      observationSource: input.outcome.observationSource,
      actionDigestSha256: input.outcome.actionDigestSha256,
      confidence: input.outcome.confidence,
      collectedAt: input.outcome.collectedAt,
    } : undefined,
    evidenceManifest: input.evidence.map((item) => ({ evidenceId: item.id, kind: item.kind, sha256: item.sha256, sizeBytes: item.sizeBytes })),
    identityAssuranceSummary: { principal: principalAssurance, agent: principalAssurance, executor: enforcementValid ? "WORKLOAD_ATTESTED" : "SELF_ASSERTED", collector: collectorAssurance },
    facts: {
      directlyObserved: outcomeProvenanceVerified ? ["outcome", ...(enforcementValid ? ["execution_event_chain", "target_reconciliation"] : [])] : [],
      thirdPartySigned: outcomeProvenanceVerified ? ["outcome_attestation", ...(enforcementValid ? ["runtime_claim", "execution_session", "reconciliation_report"] : [])] : [],
      inferred: ["policy_effect", "mandate_scope_match"],
      selfReported: input.outcome && !outcomeProvenanceVerified ? ["outcome"] : [],
    },
    controls: {
      controlled: enforcementValid ? ["execution_grant", "one_time_claim", "runtime_identity", "credential_isolated_adapter", "bounded_browser_session", "event_chain", "outcome_probe", "sandbox_reconciliation"] : ["policy_evaluation", ...(approvalBindings.some((item) => item.bindingValid) ? ["approval_binding"] : [])],
      notControlled: enforcementValid ? ["agent_behavior_outside_this_action", "target_paths_outside_reconciled_sandbox_credential"] : ["target_system_credentials", "alternate_execution_paths", "network_egress"],
    },
    issuedAt: now.toISOString(),
    validUntil: new Date(input.validUntil).toISOString(),
    currentStatus: "ACTIVE",
    statusEndpoint: input.statusEndpoint,
    warnings: [...new Set(warnings)].sort(),
  };
  const coreSha256 = sha256(canonicalJson(core));
  return { core, coreSha256, signatureSet: input.signer ? [input.signer.attestCanonical(core, core.issuedAt)] : [] };
}

export function verifyActionAssuranceReceipt(
  receipt: ActionAssuranceReceipt,
  trustBundle: Record<string, string> = {},
  at = new Date(),
  browserProof?: { evidence: BrowserEnforcementEvidenceBundle; runtimeIdentity: RuntimeIdentityRecord },
): ReceiptVerificationResult {
  const checks: ReceiptVerificationCheck[] = [];
  const digestMatches = sha256(canonicalJson(receipt.core)) === receipt.coreSha256;
  checks.push(check("payload_integrity", digestMatches, "receipt_digest_mismatch", "Receipt core digest matches canonical bytes."));
  checks.push(check("schema_version", receipt.core.receiptSchemaVersion === ACTION_ASSURANCE_RECEIPT_VERSION, "unsupported_schema", `Receipt schema is ${ACTION_ASSURANCE_RECEIPT_VERSION}.`));
  const signatures = receipt.signatureSet;
  if (!signatures.length) checks.push({ id: "issuer_signature", result: "WARN", reasonCode: "signature_missing", message: "Receipt has no issuer attestation." });
  for (const attestation of signatures) {
    const publicKey = trustBundle[attestation.keyId];
    if (!publicKey) checks.push({ id: `issuer_signature:${attestation.keyId}`, result: "NOT_CHECKED", reasonCode: "issuer_key_untrusted", message: `Trust bundle does not contain ${attestation.keyId}.` });
    else checks.push(check(`issuer_signature:${attestation.keyId}`, verifyCanonicalAttestation(receipt.core, attestation, publicKey), "signature_invalid", "Issuer signature verifies against the trust bundle."));
  }
  checks.push(check("validity_period", at.getTime() >= Date.parse(receipt.core.issuedAt) && at.getTime() < Date.parse(receipt.core.validUntil), "receipt_expired_or_not_yet_valid", "Receipt is within its declared validity period."));
  checks.push(check("policy_binding", receipt.core.policyDecision.actionDigestSha256 === receipt.core.actionIntentDigest, "policy_action_mismatch", "Policy decision is bound to the action digest."));
  const invalidApproval = receipt.core.approvals.some((approval) => !approval.bindingValid);
  checks.push(invalidApproval
    ? { id: "approval_binding", result: "FAIL", reasonCode: "approval_action_mismatch", message: "At least one approval is not bound to this action digest." }
    : { id: "approval_binding", result: "PASS", reasonCode: "approval_binding_valid", message: "All included approvals are bound to this action digest." });
  if (receipt.core.enforcementLevel === "ENFORCED") {
    checks.push(check("enforcement_proof", Boolean(receipt.core.executionGrantDigest && receipt.core.enforcementMethod !== "NONE"), "enforcement_proof_missing", "Enforced receipt includes a grant and enforcement method."));
    if (!browserProof) {
      checks.push({ id: "browser_enforcement_profile", result: "NOT_CHECKED", reasonCode: "enforcement_evidence_not_provided", message: "Cryptographic receipt verification completed, but the Browser enforcement proof bundle and current runtime trust were not provided." });
    } else {
      const evaluation = classifyBrowserEnforcement({ bundle: browserProof.evidence, runtimeIdentity: browserProof.runtimeIdentity, issuerKeys: trustBundle, now: at });
      checks.push(check("browser_enforcement_profile", evaluation.enforcementLevel === "ENFORCED" && evaluation.assuranceProfile === receipt.core.assuranceProfile, evaluation.reasonCodes[0] ?? "enforcement_profile_invalid", "Browser enforcement proof independently satisfies the claimed profile."));
      checks.push(check("execution_grant_digest", browserProof.evidence.executionGrant.payloadSha256 === receipt.core.executionGrantDigest, "execution_grant_digest_mismatch", "Receipt references the verified ExecutionGrant digest."));
      checks.push(check("event_chain_digest", browserProof.evidence.eventCheckpoint.payloadSha256 === receipt.core.actionEventChainDigest, "event_chain_digest_mismatch", "Receipt references the verified event-chain checkpoint."));
      checks.push(check("outcome_attestation_digest", browserProof.evidence.outcomeAttestation.payloadSha256 === receipt.core.outcomeAttestationDigest, "outcome_attestation_digest_mismatch", "Receipt references the verified outcome attestation."));
      checks.push(check("reconciliation_digest", browserProof.evidence.reconciliationReport.payloadSha256 === receipt.core.reconciliationReportDigest, "reconciliation_digest_mismatch", "Receipt references the verified reconciliation report."));
    }
  } else checks.push({ id: "enforcement_proof", result: "WARN", reasonCode: "not_enforced", message: `Execution is classified as ${receipt.core.enforcementLevel}.` });
  if (!receipt.core.outcomeAttestation) checks.push({ id: "outcome", result: "WARN", reasonCode: "outcome_not_observed", message: "No outcome attestation is present." });
  else checks.push(check("outcome_binding", receipt.core.outcomeAttestation.actionDigestSha256 === receipt.core.actionIntentDigest, "outcome_action_mismatch", "Outcome attestation is bound to the action digest."));
  if (receipt.core.currentStatus === "REVOKED") return { result: "REVOKED", checks };
  if (receipt.core.currentStatus === "DISPUTED") return { result: "DISPUTED", checks };
  if (checks.some((item) => item.result === "FAIL")) return { result: "INVALID", checks };
  if (checks.some((item) => item.result === "NOT_CHECKED")) return { result: "REVIEW_REQUIRED", checks };
  if (checks.some((item) => item.result === "WARN") || receipt.core.warnings.length) return { result: "VALID_WITH_WARNINGS", checks };
  return { result: "VALID", checks };
}

function check(id: string, passed: boolean, failureCode: string, message: string): ReceiptVerificationCheck {
  return { id, result: passed ? "PASS" : "FAIL", reasonCode: passed ? `${id}_valid` : failureCode, message };
}

function isSubset<T>(child: readonly T[], parent: readonly T[]): boolean {
  const allowed = new Set(parent);
  return child.every((item) => allowed.has(item));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
