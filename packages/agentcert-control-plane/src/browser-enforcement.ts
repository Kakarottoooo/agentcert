import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { canonicalJson, EvidenceSigner, type ServerAttestation, verifyCanonicalAttestation } from "./signing.js";

export const BROWSER_ENFORCEMENT_PROTOCOL = "agentcert.browser_enforcement.v0.2" as const;
export const BROWSER_ENFORCEMENT_PROFILE = "BROWSER_ENFORCED_V0_2" as const;
export const EXECUTION_GRANT_CONTEXT = "agentcert.execution-grant.v0.2" as const;
export const RUNTIME_CLAIM_CONTEXT = "onegent.runtime-claim.v0.2" as const;
export const EXECUTION_SESSION_CONTEXT = "onegent.execution-session.v0.2" as const;
export const EVENT_CONTEXT = "onegent.execution-event.v0.2" as const;
export const EVENT_CHECKPOINT_CONTEXT = "onegent.event-checkpoint.v0.2" as const;
export const OUTCOME_CONTEXT = "onegent.outcome-attestation.v0.2" as const;
export const RECONCILIATION_CONTEXT = "onegent.reconciliation-report.v0.2" as const;

export type ExecutionGrantStatus = "ISSUED" | "CLAIMED" | "CONSUMED" | "EXPIRED" | "REVOKED" | "ABANDONED" | "FAILED";
export type RuntimeIdentityStatus = "ACTIVE" | "SUSPENDED" | "REVOKED" | "COMPROMISED" | "EXPIRED";
export type CredentialIsolationMode = "PREAUTHENTICATED_BROWSER_CONTEXT" | "RUNTIME_INJECTED_CREDENTIAL" | "TARGET_EPHEMERAL_TOKEN" | "RUNTIME_MANAGED_SESSION" | "AGENT_PROVIDED_SECRET" | "PLAINTEXT_SECRET_IN_PROMPT" | "PLAINTEXT_SECRET_IN_TOOL_ARGUMENTS" | "UNKNOWN";
export type OutcomeObservationIndependence = "TARGET_SIGNED" | "SEPARATE_READ_ONLY_PROBE" | "SAME_RUNTIME_SEPARATE_CONTEXT" | "AGENT_CONTROLLED" | "SELF_REPORTED" | "UNKNOWN";
export type ReconciliationResult = "PASSED" | "BYPASS_DETECTED" | "INCOMPLETE" | "NOT_SUPPORTED" | "FAILED";
export type EnforcementCheckResult = "PASS" | "FAIL" | "WARN" | "NOT_CHECKED";

export interface DetachedRuntimeSignature {
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
}

export interface RuntimeSignedObject<T> {
  payload: T;
  payloadSha256: string;
  signature: DetachedRuntimeSignature;
}

export interface ExecutionGrantPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "ExecutionGrant";
  signatureContext: typeof EXECUTION_GRANT_CONTEXT;
  executionGrantId: string;
  tenantId: string;
  actionId: string;
  actionIntentDigest: string;
  principalIdentityId: string;
  agentIdentityId: string;
  agentBuildId: string;
  agentBuildDigest: string;
  mandateId: string;
  mandateChainDigest: string;
  policyDecisionId: string;
  policyDecisionDigest: string;
  approvalSetDigest: string;
  adapterId: string;
  adapterVersionConstraint: string;
  expectedRuntimeIdentityId: string;
  targetAudience: string;
  allowedOrigins: string[];
  allowedOperation: string;
  allowedResource: string;
  parametersDigest: string;
  outcomePredicateDigest: string;
  credentialIsolationRequirement: "REQUIRED";
  reconciliationRequirement: "REQUIRED";
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  maxUses: 1;
  nonce: string;
  jti: string;
  issuerKeyId: string;
}

export interface SignedExecutionGrant {
  payload: ExecutionGrantPayload;
  payloadSha256: string;
  attestation: ServerAttestation;
}

export interface ExecutionGrantRecord {
  id: string;
  projectId: string;
  actionId: string;
  grant: SignedExecutionGrant;
  status: ExecutionGrantStatus;
  claimedByRuntimeIdentityId?: string;
  executionSessionId?: string;
  claimIdempotencyKey?: string;
  claimedAt?: string;
  consumedAt?: string;
  revokedAt?: string;
  stateReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeIdentityRecord {
  runtimeIdentityId: string;
  projectId: string;
  runtimeInstanceId: string;
  runtimeType: "ONEGENT_BROWSER_GATEWAY";
  adapterCapabilities: string[];
  publicKeyPem: string;
  keyId: string;
  keyAlgorithm: "Ed25519";
  status: RuntimeIdentityStatus;
  validFrom: string;
  validUntil: string;
  registeredAt: string;
  registrationMethod: "PROJECT_ADMIN" | "DEVELOPMENT_FIXTURE";
  metadata: Record<string, unknown>;
  statusChangedAt?: string;
  statusReason?: string;
}

export interface RuntimeClaimPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "RuntimeClaim";
  signatureContext: typeof RUNTIME_CLAIM_CONTEXT;
  runtimeIdentityId: string;
  executionGrantId: string;
  executionGrantDigest: string;
  actionId: string;
  executionSessionId: string;
  claimNonce: string;
  claimedAt: string;
  runtimeKeyId: string;
  idempotencyKey: string;
}

export interface ExecutionSessionAttestationPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "ExecutionSessionAttestation";
  signatureContext: typeof EXECUTION_SESSION_CONTEXT;
  executionSessionId: string;
  executionGrantId: string;
  executionGrantDigest: string;
  actionId: string;
  actionIntentDigest: string;
  runtimeIdentityId: string;
  runtimeKeyId: string;
  adapterId: string;
  adapterVersion: string;
  browserContextIdDigest: string;
  credentialLeaseId: string;
  credentialIsolationMode: CredentialIsolationMode;
  targetAudience: string;
  allowedOrigins: string[];
  startedAt: string;
  sessionExpiresAt: string;
  eventChainGenesisHash: string;
}

export interface CredentialLeaseSummary {
  credentialLeaseId: string;
  tenantId: string;
  actionId: string;
  executionSessionId: string;
  providerType: "DEVELOPMENT_SECRET_PROVIDER" | "CUSTOMER_SECRET_PROVIDER";
  providerReference: string;
  targetAudience: string;
  scopeDigest: string;
  isolationMode: CredentialIsolationMode;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED" | "FAILED";
}

export type BrowserExecutionEventType =
  | "EXECUTION_GRANT_VERIFIED"
  | "EXECUTION_GRANT_CLAIMED"
  | "EXECUTION_SESSION_STARTED"
  | "CREDENTIAL_LEASE_ACTIVATED"
  | "BROWSER_CONTEXT_CREATED"
  | "TARGET_NAVIGATION"
  | "AUTHORIZED_ACTION_PREPARED"
  | "FINAL_PARAMETERS_VERIFIED"
  | "HIGH_RISK_SUBMISSION_STARTED"
  | "HIGH_RISK_SUBMISSION_COMPLETED"
  | "TARGET_RESPONSE_OBSERVED"
  | "OUTCOME_PROBE_STARTED"
  | "OUTCOME_OBSERVED"
  | "CREDENTIAL_LEASE_REVOKED"
  | "EXECUTION_SESSION_COMPLETED"
  | "EXECUTION_SESSION_FAILED";

export interface BrowserExecutionEventPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "ExecutionEvent";
  signatureContext: typeof EVENT_CONTEXT;
  eventId: string;
  actionId: string;
  executionSessionId: string;
  sequence: number;
  previousEventHash: string;
  eventType: BrowserExecutionEventType;
  sourceIdentityId: string;
  sourceTimestamp: string;
  receivedTimestamp: string;
  payloadDigest: string;
  redactedPayload: Record<string, unknown>;
  evidenceReference?: string;
}

export interface EventChainCheckpointPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "EventChainCheckpoint";
  signatureContext: typeof EVENT_CHECKPOINT_CONTEXT;
  actionId: string;
  executionSessionId: string;
  eventCount: number;
  firstEventHash: string;
  finalEventHash: string;
  completedAt: string;
}

export interface OutcomeAttestationV02Payload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "OutcomeAttestation";
  signatureContext: typeof OUTCOME_CONTEXT;
  outcomeAttestationId: string;
  actionId: string;
  executionSessionId: string;
  executionGrantId: string;
  predicateId: string;
  predicateVersion: string;
  predicateDigest: string;
  expectedStateDigest: string;
  observedStateDigest: string;
  result: "SATISFIED" | "NOT_SATISFIED" | "PARTIALLY_SATISFIED" | "INCONCLUSIVE" | "NOT_OBSERVED";
  observationMethod: "TARGET_API" | "TARGET_AUDIT_LOG" | "TARGET_UI" | "WEBHOOK" | "DATABASE_QUERY" | "THIRD_PARTY_CONFIRMATION" | "AGENT_SELF_REPORT";
  observationIndependence: OutcomeObservationIndependence;
  observationSource: string;
  sourceEvidenceDigest: string;
  evidenceReferences: string[];
  collectorIdentityId: string;
  collectorKeyId: string;
  collectedAt: string;
  confidence: number;
  limitations: string[];
}

export interface ReconciliationTargetEvent {
  targetEventId: string;
  actionId?: string;
  executionSessionId?: string;
  occurredAt: string;
  operation: string;
  resource: string;
  parametersDigest: string;
  credentialReferenceDigest: string;
}

export interface ReconciliationReportPayload {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  objectType: "ReconciliationReport";
  signatureContext: typeof RECONCILIATION_CONTEXT;
  reconciliationReportId: string;
  tenantId: string;
  actionId: string;
  executionSessionId: string;
  targetSystem: string;
  accountOrCredentialReferenceDigest: string;
  reconciliationWindowStart: string;
  reconciliationWindowEnd: string;
  expectedActionIds: string[];
  observedTargetEvents: ReconciliationTargetEvent[];
  matchedEvents: string[];
  unmatchedTargetEvents: string[];
  unmatchedReceipts: string[];
  duplicateMatches: string[];
  result: ReconciliationResult;
  limitations: string[];
  collectorIdentityId: string;
  collectedAt: string;
}

export interface BrowserEnforcementEvidenceBundle {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  executionGrant: SignedExecutionGrant;
  grantStatus: ExecutionGrantStatus;
  runtimeClaim: RuntimeSignedObject<RuntimeClaimPayload>;
  executionSession: RuntimeSignedObject<ExecutionSessionAttestationPayload>;
  credentialLease: CredentialLeaseSummary;
  events: Array<RuntimeSignedObject<BrowserExecutionEventPayload>>;
  eventCheckpoint: RuntimeSignedObject<EventChainCheckpointPayload>;
  outcomeAttestation: RuntimeSignedObject<OutcomeAttestationV02Payload>;
  reconciliationReport: RuntimeSignedObject<ReconciliationReportPayload>;
  finalParametersDigest: string;
  detectedBypass: boolean;
}

export interface BrowserEnforcementSessionRecord {
  id: string;
  projectId: string;
  actionId: string;
  executionGrantId: string;
  runtimeIdentityId: string;
  runtimeClaim: RuntimeSignedObject<RuntimeClaimPayload>;
  sessionAttestation?: RuntimeSignedObject<ExecutionSessionAttestationPayload>;
  evidenceBundle?: BrowserEnforcementEvidenceBundle;
  evaluation?: BrowserEnforcementEvaluation;
  status: "CLAIMED" | "EXECUTING" | "COMPLETED" | "FAILED" | "ABANDONED";
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionGrantClaimResult {
  result: "CLAIMED" | "IDEMPOTENT_RETRY" | "REPLAY_REJECTED" | "UNAVAILABLE";
  grant?: ExecutionGrantRecord;
  session?: BrowserEnforcementSessionRecord;
}

export interface EnforcementEvaluationCheck {
  id: string;
  result: EnforcementCheckResult;
  reasonCode: string;
  message: string;
}

export interface BrowserEnforcementEvaluation {
  enforcementLevel: "ENFORCED" | "OBSERVED_ONLY" | "SELF_REPORTED";
  assuranceProfile?: typeof BROWSER_ENFORCEMENT_PROFILE;
  checks: EnforcementEvaluationCheck[];
  reasonCodes: string[];
  limitations: string[];
  verifiedAt: string;
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createSignedExecutionGrant(input: Omit<ExecutionGrantPayload, "protocolVersion" | "objectType" | "signatureContext" | "maxUses" | "nonce" | "jti" | "issuerKeyId"> & { signer: EvidenceSigner }): SignedExecutionGrant {
  const { signer, ...bindings } = input;
  const payload: ExecutionGrantPayload = {
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "ExecutionGrant",
    signatureContext: EXECUTION_GRANT_CONTEXT,
    ...bindings,
    maxUses: 1,
    nonce: randomBytes(24).toString("base64url"),
    jti: randomUUID(),
    issuerKeyId: signer.keyId,
  };
  return { payload, payloadSha256: digestCanonical(payload), attestation: signer.attestCanonical(payload, payload.issuedAt) };
}

export function verifySignedExecutionGrant(grant: SignedExecutionGrant, issuerKeys: Record<string, string>, at = new Date(), clockSkewMs = 30_000): string[] {
  const errors: string[] = [];
  const payload = grant.payload;
  if (payload.protocolVersion !== BROWSER_ENFORCEMENT_PROTOCOL || payload.objectType !== "ExecutionGrant" || payload.signatureContext !== EXECUTION_GRANT_CONTEXT) errors.push("UNSUPPORTED_PROTOCOL_VERSION");
  if (payload.maxUses !== 1) errors.push("EXECUTION_GRANT_MAX_USES_INVALID");
  if (grant.payloadSha256 !== digestCanonical(payload)) errors.push("EXECUTION_GRANT_DIGEST_MISMATCH");
  const issuerKey = issuerKeys[payload.issuerKeyId];
  if (!issuerKey) errors.push("EXECUTION_GRANT_UNKNOWN_ISSUER");
  else if (!verifyCanonicalAttestation(payload, grant.attestation, issuerKey)) errors.push("EXECUTION_GRANT_INVALID_SIGNATURE");
  const timestamp = at.getTime();
  if (timestamp + clockSkewMs < Date.parse(payload.notBefore)) errors.push("EXECUTION_GRANT_NOT_YET_VALID");
  if (timestamp - clockSkewMs >= Date.parse(payload.expiresAt)) errors.push("EXECUTION_GRANT_EXPIRED");
  if (!validDigest(payload.actionIntentDigest) || !validDigest(payload.agentBuildDigest) || !validDigest(payload.parametersDigest) || !validDigest(payload.outcomePredicateDigest)) errors.push("EXECUTION_GRANT_BINDING_INVALID");
  if (containsSecretMaterial(grant)) errors.push("CREDENTIAL_LEAK_DETECTED");
  return [...new Set(errors)];
}

export function verifyRuntimeSignedObject<T>(value: RuntimeSignedObject<T>, publicKeyPem: string, expectedKeyId: string): boolean {
  if (value.signature.algorithm !== "Ed25519" || value.signature.keyId !== expectedKeyId || value.payloadSha256 !== digestCanonical(value.payload)) return false;
  try {
    return verify(null, Buffer.from(value.payloadSha256, "hex"), createPublicKey(publicKeyPem), Buffer.from(value.signature.signature, "base64url"));
  } catch {
    return false;
  }
}

export function runtimeIdentityTrustedAt(runtime: RuntimeIdentityRecord | undefined, at: Date): boolean {
  if (!runtime || !Number.isFinite(at.getTime())) return false;
  if (at < new Date(runtime.validFrom) || at >= new Date(runtime.validUntil)) return false;
  if (runtime.status === "ACTIVE" || runtime.status === "EXPIRED") return true;
  const distrustedAt = runtime.statusChangedAt ? new Date(runtime.statusChangedAt) : new Date(runtime.validFrom);
  return Number.isFinite(distrustedAt.getTime()) && at < distrustedAt;
}

export function classifyBrowserEnforcement(input: {
  bundle: BrowserEnforcementEvidenceBundle;
  runtimeIdentity?: RuntimeIdentityRecord;
  issuerKeys: Record<string, string>;
  now?: Date;
  clockSkewMs?: number;
}): BrowserEnforcementEvaluation {
  const now = input.now ?? new Date();
  const bundle = input.bundle;
  const grant = bundle.executionGrant;
  const runtime = input.runtimeIdentity;
  const checks: EnforcementEvaluationCheck[] = [];
  const add = (id: string, passed: boolean, reasonCode: string, message: string) => checks.push({ id, result: passed ? "PASS" : "FAIL", reasonCode: passed ? `${id.toUpperCase()}_VALID` : reasonCode, message });
  const grantErrors = verifySignedExecutionGrant(grant, input.issuerKeys, new Date(bundle.runtimeClaim.payload.claimedAt), input.clockSkewMs);
  add("execution_grant", grantErrors.length === 0, grantErrors[0] ?? "EXECUTION_GRANT_INVALID", "Hosted ExecutionGrant signature, TTL, and binding fields verify.");
  add("grant_redemption", bundle.grantStatus === "CONSUMED", bundle.grantStatus === "REVOKED" ? "EXECUTION_GRANT_REVOKED" : "EXECUTION_GRANT_ALREADY_CLAIMED", "ExecutionGrant was atomically claimed and consumed exactly once.");
  const runtimeClaimedAt = new Date(bundle.runtimeClaim.payload.claimedAt);
  const runtimeTrustedAtClaim = runtimeIdentityTrustedAt(runtime, runtimeClaimedAt);
  add("runtime_identity", runtimeTrustedAtClaim, "RUNTIME_IDENTITY_UNTRUSTED", "Onegent runtime identity was trusted when the grant was claimed.");
  const runtimeKey = runtime?.publicKeyPem ?? "";
  const runtimeClaimValid = Boolean(runtime && verifyRuntimeSignedObject(bundle.runtimeClaim, runtimeKey, runtime.keyId));
  add("runtime_claim", runtimeClaimValid, "RUNTIME_PROOF_INVALID", "RuntimeClaim proves possession of the registered runtime key.");
  const claim = bundle.runtimeClaim.payload;
  add("runtime_claim_binding", claim.executionGrantId === grant.payload.executionGrantId && claim.executionGrantDigest === grant.payloadSha256 && claim.actionId === grant.payload.actionId && claim.runtimeIdentityId === grant.payload.expectedRuntimeIdentityId, "RUNTIME_CLAIM_BINDING_MISMATCH", "RuntimeClaim is bound to the exact grant, action, and expected runtime.");
  const sessionSignatureValid = Boolean(runtime && verifyRuntimeSignedObject(bundle.executionSession, runtimeKey, runtime.keyId));
  add("execution_session", sessionSignatureValid, "EXECUTION_SESSION_INVALID", "ExecutionSessionAttestation is signed by the trusted runtime.");
  const session = bundle.executionSession.payload;
  add("session_binding", session.executionGrantDigest === grant.payloadSha256 && session.executionGrantId === grant.payload.executionGrantId && session.executionSessionId === claim.executionSessionId && session.actionIntentDigest === grant.payload.actionIntentDigest && session.adapterId === grant.payload.adapterId && versionSatisfiesConstraint(session.adapterVersion, grant.payload.adapterVersionConstraint) && session.targetAudience === grant.payload.targetAudience && digestCanonical([...session.allowedOrigins].sort()) === digestCanonical([...grant.payload.allowedOrigins].sort()), "EXECUTION_SESSION_BINDING_MISMATCH", "Execution session is bound to the grant, action, adapter version, and target origins.");
  const strongIsolation = new Set<CredentialIsolationMode>(["PREAUTHENTICATED_BROWSER_CONTEXT", "RUNTIME_INJECTED_CREDENTIAL", "TARGET_EPHEMERAL_TOKEN", "RUNTIME_MANAGED_SESSION"]);
  const lease = bundle.credentialLease;
  add("credential_isolation", strongIsolation.has(lease.isolationMode) && lease.status === "REVOKED" && Boolean(lease.revokedAt) && lease.executionSessionId === session.executionSessionId && lease.credentialLeaseId === session.credentialLeaseId, "CREDENTIAL_ISOLATION_UNPROVEN", "Credential stayed in the runtime boundary and its lease was revoked after execution.");
  add("secret_redaction", !containsSecretMaterial(bundle), "CREDENTIAL_LEAK_DETECTED", "No credential-shaped field or secret value appears in the proof bundle.");
  const eventValidation = validateEventChain(bundle.events, bundle.eventCheckpoint, session, runtime);
  add("event_chain", eventValidation.errors.length === 0, eventValidation.errors[0] ?? "EVENT_CHAIN_INVALID", "Complete signed event chain is ordered, bound, and hash-linked.");
  add("final_parameters", bundle.finalParametersDigest === grant.payload.parametersDigest, "PARAMETERS_DIGEST_MISMATCH", "Final submitted parameters match the approved digest.");
  const outcomeSignatureValid = Boolean(runtime && verifyRuntimeSignedObject(bundle.outcomeAttestation, runtimeKey, runtime.keyId));
  add("outcome_signature", outcomeSignatureValid, "OUTCOME_ATTESTATION_INVALID", "OutcomeAttestation is signed by the registered collector/runtime key.");
  const outcome = bundle.outcomeAttestation.payload;
  const outcomeIndependent = new Set<OutcomeObservationIndependence>(["TARGET_SIGNED", "SEPARATE_READ_ONLY_PROBE", "SAME_RUNTIME_SEPARATE_CONTEXT"]).has(outcome.observationIndependence);
  add("outcome_independence", outcomeIndependent && outcome.actionId === grant.payload.actionId && outcome.executionSessionId === session.executionSessionId && outcome.predicateDigest === grant.payload.outcomePredicateDigest && Date.parse(outcome.collectedAt) >= Date.parse(session.startedAt), "OUTCOME_NOT_INDEPENDENT", "Outcome was observed after execution through a separate read path and bound predicate.");
  const reconciliationSignatureValid = Boolean(runtime && verifyRuntimeSignedObject(bundle.reconciliationReport, runtimeKey, runtime.keyId));
  add("reconciliation_signature", reconciliationSignatureValid, "RECONCILIATION_INVALID", "ReconciliationReport is signed by the registered runtime collector.");
  const reconciliation = bundle.reconciliationReport.payload;
  add("reconciliation", reconciliation.result === "PASSED" && !reconciliation.unmatchedTargetEvents.length && !reconciliation.unmatchedReceipts.length && !reconciliation.duplicateMatches.length && reconciliation.actionId === grant.payload.actionId && reconciliation.executionSessionId === session.executionSessionId, reconciliation.result === "BYPASS_DETECTED" ? "BYPASS_DETECTED" : "RECONCILIATION_INCOMPLETE", "Exclusive sandbox audit events reconcile one-to-one with the enforced action.");
  add("bypass", !bundle.detectedBypass, "BYPASS_DETECTED", "No alternate target-system write path was detected in the reconciliation window.");
  add("tenant_binding", Boolean(runtime && runtime.projectId === grant.payload.tenantId), "EXECUTION_GRANT_TENANT_MISMATCH", "Grant and runtime identity belong to the same tenant.");
  add("adapter_binding", Boolean(runtime?.adapterCapabilities.includes(grant.payload.adapterId)), "ADAPTER_MISMATCH", "Runtime is registered for the exact browser adapter.");
  const failures = checks.filter((item) => item.result === "FAIL");
  const independentOutcomePresent = outcomeSignatureValid && outcomeIndependent;
  const enforcementLevel = failures.length === 0 ? "ENFORCED" : independentOutcomePresent ? "OBSERVED_ONLY" : "SELF_REPORTED";
  return {
    enforcementLevel,
    assuranceProfile: enforcementLevel === "ENFORCED" ? BROWSER_ENFORCEMENT_PROFILE : undefined,
    checks,
    reasonCodes: failures.map((item) => item.reasonCode),
    limitations: enforcementLevel === "ENFORCED"
      ? ["This profile controls one declared browser action; it does not prove universal agent safety or absence of write paths outside the reconciled sandbox account."]
      : failures.map((item) => item.message),
    verifiedAt: now.toISOString(),
  };
}

export function validateEventChain(
  events: Array<RuntimeSignedObject<BrowserExecutionEventPayload>>,
  checkpoint: RuntimeSignedObject<EventChainCheckpointPayload>,
  session: ExecutionSessionAttestationPayload,
  runtime?: RuntimeIdentityRecord,
): { errors: string[]; finalHash?: string } {
  const errors: string[] = [];
  const required: BrowserExecutionEventType[] = [
    "EXECUTION_GRANT_VERIFIED", "EXECUTION_GRANT_CLAIMED", "EXECUTION_SESSION_STARTED", "CREDENTIAL_LEASE_ACTIVATED",
    "BROWSER_CONTEXT_CREATED", "TARGET_NAVIGATION", "AUTHORIZED_ACTION_PREPARED", "FINAL_PARAMETERS_VERIFIED",
    "HIGH_RISK_SUBMISSION_STARTED", "HIGH_RISK_SUBMISSION_COMPLETED", "TARGET_RESPONSE_OBSERVED", "OUTCOME_PROBE_STARTED",
    "OUTCOME_OBSERVED", "CREDENTIAL_LEASE_REVOKED", "EXECUTION_SESSION_COMPLETED",
  ];
  let previous = session.eventChainGenesisHash;
  const seenIds = new Set<string>();
  const seenTypes = new Set<BrowserExecutionEventType>();
  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]!;
    const event = item.payload;
    if (!runtime || !verifyRuntimeSignedObject(item, runtime.publicKeyPem, runtime.keyId)) errors.push("EVENT_SIGNATURE_INVALID");
    if (event.protocolVersion !== BROWSER_ENFORCEMENT_PROTOCOL || event.signatureContext !== EVENT_CONTEXT || event.objectType !== "ExecutionEvent") errors.push("EVENT_PROTOCOL_INVALID");
    if (event.sequence !== index + 1) errors.push("EVENT_CHAIN_INCOMPLETE");
    if (event.previousEventHash !== previous) errors.push("EVENT_CHAIN_INVALID");
    if (event.actionId !== session.actionId || event.executionSessionId !== session.executionSessionId || event.sourceIdentityId !== session.runtimeIdentityId) errors.push("EVENT_BINDING_MISMATCH");
    if (seenIds.has(event.eventId)) errors.push("EVENT_DUPLICATE");
    if (event.payloadDigest !== digestCanonical(event.redactedPayload)) errors.push("EVENT_PAYLOAD_DIGEST_MISMATCH");
    seenIds.add(event.eventId);
    seenTypes.add(event.eventType);
    previous = item.payloadSha256;
  }
  for (const type of required) if (!seenTypes.has(type)) errors.push("EVENT_CHAIN_INCOMPLETE");
  if (seenTypes.has("EXECUTION_SESSION_FAILED")) errors.push("EXECUTION_SESSION_FAILED");
  if (!runtime || !verifyRuntimeSignedObject(checkpoint, runtime.publicKeyPem, runtime.keyId)) errors.push("EVENT_CHECKPOINT_SIGNATURE_INVALID");
  const cp = checkpoint.payload;
  if (cp.signatureContext !== EVENT_CHECKPOINT_CONTEXT || cp.executionSessionId !== session.executionSessionId || cp.actionId !== session.actionId || cp.eventCount !== events.length || cp.firstEventHash !== events[0]?.payloadSha256 || cp.finalEventHash !== previous) errors.push("EVENT_CHECKPOINT_MISMATCH");
  return { errors: [...new Set(errors)], finalHash: previous };
}

export function containsSecretMaterial(value: unknown): boolean {
  const secretKey = /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|raw[_-]?credential|credentialValue)/i;
  const secretValue = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_(?:live|test)_[A-Za-z0-9]{8,})/i;
  const visit = (input: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    if (typeof input === "string") return secretValue.test(input);
    if (Array.isArray(input)) return input.some((item) => visit(item, depth + 1));
    if (input && typeof input === "object") return Object.entries(input as Record<string, unknown>).some(([key, child]) => secretKey.test(key) || visit(child, depth + 1));
    return false;
  };
  return visit(value, 0);
}

function versionSatisfiesConstraint(version: string, constraint: string): boolean {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsed) return false;
  const exact = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(constraint);
  if (exact) return parsed.slice(1).join(".") === exact.slice(1).join(".");
  const compatible = /^\^v?(\d+)\.(\d+)\.(\d+)$/.exec(constraint);
  if (!compatible) return false;
  const [major, minor, patch] = parsed.slice(1).map(Number);
  const [requiredMajor, requiredMinor, requiredPatch] = compatible.slice(1).map(Number);
  return major === requiredMajor && (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch));
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
