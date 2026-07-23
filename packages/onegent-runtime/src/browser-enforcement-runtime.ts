import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { ActionIntent, ActionExecutionSummary } from "./types.js";
import type { ControlledActionAdapter, IndependentOutcomeProbe, SourceSigner, TrustedRecordType } from "./trust-types.js";
import type { TrustedActionRecorder } from "./trusted-recorder.js";
import { canonicalJson, sha256, signDigest } from "./trust-crypto.js";
import { isRegisteredControlledActionAdapter, isRegisteredIndependentOutcomeProbe } from "./controlled-adapter.js";

export const BROWSER_ENFORCEMENT_PROTOCOL = "agentcert.browser_enforcement.v0.2" as const;
export const EXECUTION_GRANT_CONTEXT = "agentcert.execution-grant.v0.2" as const;
export const RUNTIME_CLAIM_CONTEXT = "onegent.runtime-claim.v0.2" as const;
export const EXECUTION_SESSION_CONTEXT = "onegent.execution-session.v0.2" as const;
export const EVENT_CONTEXT = "onegent.execution-event.v0.2" as const;
export const EVENT_CHECKPOINT_CONTEXT = "onegent.event-checkpoint.v0.2" as const;
export const OUTCOME_CONTEXT = "onegent.outcome-attestation.v0.2" as const;
export const RECONCILIATION_CONTEXT = "onegent.reconciliation-report.v0.2" as const;

type CredentialIsolationMode = "PREAUTHENTICATED_BROWSER_CONTEXT" | "RUNTIME_INJECTED_CREDENTIAL" | "TARGET_EPHEMERAL_TOKEN" | "RUNTIME_MANAGED_SESSION";

export interface HostedAttestation {
  schemaVersion: "agentcert.server_attestation.v0.1";
  algorithm: "Ed25519";
  keyId: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
}

export interface ExecutionGrantWirePayload {
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

export interface SignedExecutionGrantWire {
  payload: ExecutionGrantWirePayload;
  payloadSha256: string;
  attestation: HostedAttestation;
}

export interface RuntimeSignedObject<T> {
  payload: T;
  payloadSha256: string;
  signature: { algorithm: "Ed25519"; keyId: string; signature: string };
}

export interface RuntimeClaimWirePayload {
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

export interface ExecutionSessionWirePayload {
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

export interface RuntimeIdentityConfig {
  runtimeIdentityId: string;
  runtimeKeyId: string;
  signer: SourceSigner;
}

export interface BrowserCredentialLeaseInput {
  credentialLeaseId?: string;
  providerType: "DEVELOPMENT_SECRET_PROVIDER" | "CUSTOMER_SECRET_PROVIDER";
  providerReference: string;
  isolationMode: CredentialIsolationMode;
  expiresAt: string;
  revoke?: () => void | Promise<void>;
}

export interface TargetAuditEvent {
  targetEventId: string;
  actionId?: string;
  executionSessionId?: string;
  occurredAt: string;
  operation: string;
  resource: string;
  parametersDigest: string;
  credentialReferenceDigest: string;
}

export interface BrowserTargetAuditSource {
  name: string;
  exclusiveCredential: true;
  listEvents(windowStart: string, windowEnd: string): Promise<TargetAuditEvent[]>;
}

export interface BrowserEnforcementExecutionOptions {
  grant: SignedExecutionGrantWire;
  hostedIssuerKeys: Record<string, string>;
  runtime: RuntimeIdentityConfig;
  action: ActionIntent;
  actionIntentDigest: string;
  agentBuildDigest: string;
  approvedParameters: Record<string, unknown>;
  outcomePredicate: Record<string, unknown>;
  adapter: ControlledActionAdapter;
  adapterVersion: string;
  outcomeProbe: IndependentOutcomeProbe;
  targetAuditSource: BrowserTargetAuditSource;
  recorder: TrustedActionRecorder;
  credentialLease: BrowserCredentialLeaseInput;
  claimGrant(claim: RuntimeSignedObject<RuntimeClaimWirePayload>): Promise<{ status: "CLAIMED"; claimedAt: string }>;
  markConsumed(executionGrantId: string, executionSessionId: string): Promise<void>;
  now?: () => Date;
  clockSkewMs?: number;
}

export interface BrowserEnforcementRuntimeBundle {
  protocolVersion: typeof BROWSER_ENFORCEMENT_PROTOCOL;
  executionGrant: SignedExecutionGrantWire;
  grantStatus: "CONSUMED";
  runtimeClaim: RuntimeSignedObject<RuntimeClaimWirePayload>;
  executionSession: RuntimeSignedObject<ExecutionSessionWirePayload>;
  credentialLease: Record<string, unknown>;
  events: Array<RuntimeSignedObject<Record<string, unknown>>>;
  eventCheckpoint: RuntimeSignedObject<Record<string, unknown>>;
  outcomeAttestation: RuntimeSignedObject<Record<string, unknown>>;
  reconciliationReport: RuntimeSignedObject<Record<string, unknown>>;
  finalParametersDigest: string;
  detectedBypass: boolean;
  execution: ActionExecutionSummary;
}

export async function executeBrowserEnforcement(options: BrowserEnforcementExecutionOptions): Promise<BrowserEnforcementRuntimeBundle> {
  const now = options.now ?? (() => new Date());
  verifyHostedExecutionGrant(options.grant, options.hostedIssuerKeys, now(), options.clockSkewMs ?? 30_000);
  assertBindings(options);
  if (!isRegisteredControlledActionAdapter(options.adapter)) throw new Error("ADAPTER_UNREGISTERED");
  if (!isRegisteredIndependentOutcomeProbe(options.outcomeProbe)) throw new Error("OUTCOME_PROBE_UNREGISTERED");
  if (options.outcomeProbe.name === options.adapter.name) throw new Error("OUTCOME_NOT_INDEPENDENT");
  const grant = options.grant.payload;
  const executionSessionId = randomUUID();
  const runtimeClaim = signRuntimeObject({
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "RuntimeClaim",
    signatureContext: RUNTIME_CLAIM_CONTEXT,
    runtimeIdentityId: options.runtime.runtimeIdentityId,
    executionGrantId: grant.executionGrantId,
    executionGrantDigest: options.grant.payloadSha256,
    actionId: grant.actionId,
    executionSessionId,
    claimNonce: randomBytes(24).toString("base64url"),
    claimedAt: now().toISOString(),
    runtimeKeyId: options.runtime.runtimeKeyId,
    idempotencyKey: `claim:${grant.jti}`,
  } satisfies RuntimeClaimWirePayload, options.runtime.signer);
  await options.claimGrant(runtimeClaim);

  const credentialLeaseId = options.credentialLease.credentialLeaseId ?? randomUUID();
  const startedAt = now().toISOString();
  const genesis = sha256(canonicalJson({ executionSessionId, executionGrantDigest: options.grant.payloadSha256, runtimeIdentityId: options.runtime.runtimeIdentityId }));
  const session = signRuntimeObject({
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "ExecutionSessionAttestation",
    signatureContext: EXECUTION_SESSION_CONTEXT,
    executionSessionId,
    executionGrantId: grant.executionGrantId,
    executionGrantDigest: options.grant.payloadSha256,
    actionId: grant.actionId,
    actionIntentDigest: grant.actionIntentDigest,
    runtimeIdentityId: options.runtime.runtimeIdentityId,
    runtimeKeyId: options.runtime.runtimeKeyId,
    adapterId: grant.adapterId,
    adapterVersion: options.adapterVersion,
    browserContextIdDigest: sha256(`browser-context:${executionSessionId}`),
    credentialLeaseId,
    credentialIsolationMode: options.credentialLease.isolationMode,
    targetAudience: grant.targetAudience,
    allowedOrigins: [...grant.allowedOrigins],
    startedAt,
    sessionExpiresAt: grant.expiresAt,
    eventChainGenesisHash: genesis,
  } satisfies ExecutionSessionWirePayload, options.runtime.signer);

  const events: Array<RuntimeSignedObject<Record<string, unknown>>> = [];
  let previousHash = genesis;
  const append = async (eventType: Exclude<TrustedRecordType, "RUN_STARTED" | "RUN_COMPLETED">, payload: Record<string, unknown> = {}) => {
    const redactedPayload = redactAndBound(payload);
    const event = {
      protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
      objectType: "ExecutionEvent",
      signatureContext: EVENT_CONTEXT,
      eventId: randomUUID(),
      actionId: grant.actionId,
      executionSessionId,
      sequence: events.length + 1,
      previousEventHash: previousHash,
      eventType,
      sourceIdentityId: options.runtime.runtimeIdentityId,
      sourceTimestamp: now().toISOString(),
      receivedTimestamp: now().toISOString(),
      payloadDigest: sha256(canonicalJson(redactedPayload)),
      redactedPayload,
    };
    const signed = signRuntimeObject(event, options.runtime.signer);
    previousHash = signed.payloadSha256;
    events.push(signed);
    await options.recorder.append(eventType, { actionId: grant.actionId, executionSessionId, ...redactedPayload });
  };

  const leaseIssuedAt = now().toISOString();
  const providerReferenceDigest = sha256(options.credentialLease.providerReference);
  const credentialLease: Record<string, unknown> = {
    credentialLeaseId,
    tenantId: grant.tenantId,
    actionId: grant.actionId,
    executionSessionId,
    providerType: options.credentialLease.providerType,
    providerReference: `opaque:${providerReferenceDigest}`,
    targetAudience: grant.targetAudience,
    scopeDigest: sha256(canonicalJson({ allowedOrigins: grant.allowedOrigins, operation: grant.allowedOperation, resource: grant.allowedResource })),
    isolationMode: options.credentialLease.isolationMode,
    issuedAt: leaseIssuedAt,
    expiresAt: options.credentialLease.expiresAt,
    status: "ACTIVE",
  };
  let leaseRevoked = false;
  const revokeCredentialLease = async () => {
    if (leaseRevoked) return;
    try {
      await options.credentialLease.revoke?.();
      credentialLease.status = "REVOKED";
    } catch (error) {
      credentialLease.status = "FAILED";
      throw error;
    } finally {
      const revokedAt = now().toISOString();
      credentialLease.revokedAt = revokedAt;
      leaseRevoked = true;
      await append("CREDENTIAL_LEASE_REVOKED", { credentialLeaseId, revokedAt, status: credentialLease.status });
    }
  };
  try {
  await append("EXECUTION_GRANT_VERIFIED", { executionGrantDigest: options.grant.payloadSha256 });
  await append("EXECUTION_GRANT_CLAIMED", { executionGrantId: grant.executionGrantId, claimDigest: runtimeClaim.payloadSha256 });
  await append("EXECUTION_SESSION_STARTED", { executionSessionDigest: session.payloadSha256 });
  await append("CREDENTIAL_LEASE_ACTIVATED", { credentialLeaseId, providerReferenceDigest, isolationMode: options.credentialLease.isolationMode });
  await append("BROWSER_CONTEXT_CREATED", { browserContextIdDigest: session.payload.browserContextIdDigest });
  await append("TARGET_NAVIGATION", { targetAudience: grant.targetAudience, origin: grant.allowedOrigins[0] });
  await append("AUTHORIZED_ACTION_PREPARED", { operation: grant.allowedOperation, resource: grant.allowedResource });
  const finalParametersDigest = sha256(canonicalJson(options.approvedParameters));
  if (finalParametersDigest !== grant.parametersDigest) {
    throw new Error("PARAMETERS_DIGEST_MISMATCH");
  }
  await append("FINAL_PARAMETERS_VERIFIED", { parametersDigest: finalParametersDigest });
  await append("HIGH_RISK_SUBMISSION_STARTED", { actionId: grant.actionId });
  const adapterResult = await options.adapter.execute(options.action, { idempotencyKey: executionSessionId, attempt: 1 });
  const execution: ActionExecutionSummary = {
    method: adapterResult.method ?? "LOCAL_ADAPTER",
    status: "COMPLETED",
    targetSystem: adapterResult.targetSystem ?? options.action.targetSystem,
    previousState: adapterResult.previousState,
    observedState: adapterResult.observedState,
    rollbackToken: adapterResult.rollbackToken,
  };
  await options.markConsumed(grant.executionGrantId, executionSessionId);
  await append("HIGH_RISK_SUBMISSION_COMPLETED", { targetSystem: execution.targetSystem });
  await append("TARGET_RESPONSE_OBSERVED", { observedStateDigest: sha256(canonicalJson(execution.observedState ?? {})) });
  await append("OUTCOME_PROBE_STARTED", { probe: options.outcomeProbe.name });
  const observation = await options.outcomeProbe.observe(options.action, execution);
  await append("OUTCOME_OBSERVED", { observationId: observation.observationId, source: observation.source, observedStateDigest: sha256(canonicalJson(observation.observedState)) });
  const predicateDigest = sha256(canonicalJson(options.outcomePredicate));
  const expectedDigest = sha256(canonicalJson(options.action.proposedAfterState));
  const observedDigest = sha256(canonicalJson(observation.observedState));
  const outcomeResult = subsetMatches(options.action.proposedAfterState, observation.observedState) ? "SATISFIED" : "NOT_SATISFIED";
  const outcomeAttestation = signRuntimeObject({
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "OutcomeAttestation",
    signatureContext: OUTCOME_CONTEXT,
    outcomeAttestationId: randomUUID(),
    actionId: grant.actionId,
    executionSessionId,
    executionGrantId: grant.executionGrantId,
    predicateId: "expected_state_subset",
    predicateVersion: "1",
    predicateDigest,
    expectedStateDigest: expectedDigest,
    observedStateDigest: observedDigest,
    result: outcomeResult,
    observationMethod: "TARGET_AUDIT_LOG",
    observationIndependence: "SEPARATE_READ_ONLY_PROBE",
    observationSource: observation.source,
    sourceEvidenceDigest: sha256(canonicalJson(observation)),
    evidenceReferences: [`target-audit:${observation.observationId}`],
    collectorIdentityId: options.runtime.runtimeIdentityId,
    collectorKeyId: options.runtime.runtimeKeyId,
    collectedAt: observation.observedAt,
    confidence: 1,
    limitations: ["The reference probe reads a dedicated sandbox audit source; it is not hardware attested."],
  }, options.runtime.signer);
  await revokeCredentialLease();
  await append("EXECUTION_SESSION_COMPLETED", { outcomeAttestationDigest: outcomeAttestation.payloadSha256 });

  const auditEvents = await options.targetAuditSource.listEvents(startedAt, now().toISOString());
  const matching = auditEvents.filter((event) => event.actionId === grant.actionId && event.executionSessionId === executionSessionId && event.operation === grant.allowedOperation && event.resource === grant.allowedResource && event.parametersDigest === grant.parametersDigest);
  const unmatchedTargetEvents = auditEvents.filter((event) => !matching.includes(event)).map((event) => event.targetEventId);
  const duplicateMatches = matching.length > 1 ? matching.slice(1).map((event) => event.targetEventId) : [];
  const reconciliationResult = options.targetAuditSource.exclusiveCredential && matching.length === 1 && !unmatchedTargetEvents.length && !duplicateMatches.length ? "PASSED" : unmatchedTargetEvents.length || duplicateMatches.length ? "BYPASS_DETECTED" : "INCOMPLETE";
  const reconciliationReport = signRuntimeObject({
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "ReconciliationReport",
    signatureContext: RECONCILIATION_CONTEXT,
    reconciliationReportId: randomUUID(),
    tenantId: grant.tenantId,
    actionId: grant.actionId,
    executionSessionId,
    targetSystem: grant.targetAudience,
    accountOrCredentialReferenceDigest: providerReferenceDigest,
    reconciliationWindowStart: startedAt,
    reconciliationWindowEnd: now().toISOString(),
    expectedActionIds: [grant.actionId],
    observedTargetEvents: auditEvents,
    matchedEvents: matching.map((event) => event.targetEventId),
    unmatchedTargetEvents,
    unmatchedReceipts: matching.length ? [] : [grant.actionId],
    duplicateMatches,
    result: reconciliationResult,
    limitations: ["Reconciliation covers the dedicated sandbox credential and declared time window only."],
    collectorIdentityId: options.runtime.runtimeIdentityId,
    collectedAt: now().toISOString(),
  }, options.runtime.signer);
  const eventCheckpoint = signRuntimeObject({
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    objectType: "EventChainCheckpoint",
    signatureContext: EVENT_CHECKPOINT_CONTEXT,
    actionId: grant.actionId,
    executionSessionId,
    eventCount: events.length,
    firstEventHash: events[0]!.payloadSha256,
    finalEventHash: events.at(-1)!.payloadSha256,
    completedAt: now().toISOString(),
  }, options.runtime.signer);

  return {
    protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
    executionGrant: options.grant,
    grantStatus: "CONSUMED",
    runtimeClaim,
    executionSession: session,
    credentialLease,
    events,
    eventCheckpoint,
    outcomeAttestation,
    reconciliationReport,
    finalParametersDigest,
    detectedBypass: reconciliationResult !== "PASSED",
    execution,
  };
  } catch (error) {
    try {
      await append("EXECUTION_SESSION_FAILED", { reasonCode: error instanceof Error ? error.message.slice(0, 200) : "EXECUTION_FAILED" });
    } finally {
      if (!leaseRevoked) await revokeCredentialLease();
    }
    throw error;
  }
}

export function verifyHostedExecutionGrant(grant: SignedExecutionGrantWire, issuerKeys: Record<string, string>, at = new Date(), clockSkewMs = 30_000): void {
  const payload = grant.payload;
  if (payload.protocolVersion !== BROWSER_ENFORCEMENT_PROTOCOL || payload.objectType !== "ExecutionGrant" || payload.signatureContext !== EXECUTION_GRANT_CONTEXT) throw new Error("UNSUPPORTED_PROTOCOL_VERSION");
  if (payload.maxUses !== 1 || grant.payloadSha256 !== sha256(canonicalJson(payload))) throw new Error("EXECUTION_GRANT_DIGEST_MISMATCH");
  const publicKey = issuerKeys[payload.issuerKeyId];
  if (!publicKey) throw new Error("EXECUTION_GRANT_UNKNOWN_ISSUER");
  const bytes = Buffer.from(canonicalJson(payload));
  if (grant.attestation.payloadSha256 !== sha256(bytes)) throw new Error("EXECUTION_GRANT_INVALID_SIGNATURE");
  let valid = false;
  try { valid = verify(null, bytes, createPublicKey(publicKey), Buffer.from(grant.attestation.signature, "base64url")); } catch { valid = false; }
  if (!valid) throw new Error("EXECUTION_GRANT_INVALID_SIGNATURE");
  if (at.getTime() + clockSkewMs < Date.parse(payload.notBefore)) throw new Error("EXECUTION_GRANT_NOT_YET_VALID");
  if (at.getTime() - clockSkewMs >= Date.parse(payload.expiresAt)) throw new Error("EXECUTION_GRANT_EXPIRED");
}

export function signRuntimeObject<T>(payload: T, signer: SourceSigner): RuntimeSignedObject<T> {
  const payloadSha256 = sha256(canonicalJson(payload));
  return { payload, payloadSha256, signature: signDigest(payloadSha256, signer) };
}

function assertBindings(options: BrowserEnforcementExecutionOptions): void {
  const grant = options.grant.payload;
  if (grant.expectedRuntimeIdentityId !== options.runtime.runtimeIdentityId) throw new Error("RUNTIME_IDENTITY_MISMATCH");
  if (grant.actionId !== options.action.id || grant.actionIntentDigest !== options.actionIntentDigest) throw new Error("ACTION_DIGEST_MISMATCH");
  if (grant.agentBuildDigest !== options.agentBuildDigest) throw new Error("AGENT_BUILD_MISMATCH");
  if (grant.adapterId !== options.adapter.name || grant.targetAudience !== options.action.targetSystem) throw new Error("ADAPTER_MISMATCH");
  if (!versionSatisfiesConstraint(options.adapterVersion, grant.adapterVersionConstraint)) throw new Error("ADAPTER_VERSION_MISMATCH");
  if (!options.action.targetUrl || !grant.allowedOrigins.includes(normalizedOrigin(options.action.targetUrl))) throw new Error("TARGET_ORIGIN_MISMATCH");
  if (!options.adapter.control.allowedActionTypes.includes(options.action.actionType) || !options.adapter.control.allowedTargetSystems.includes(options.action.targetSystem)) throw new Error("ADAPTER_SCOPE_MISMATCH");
  if (sha256(canonicalJson(options.outcomePredicate)) !== grant.outcomePredicateDigest) throw new Error("OUTCOME_PREDICATE_MISMATCH");
}

function normalizedOrigin(value: string): string {
  try { return new URL(value).origin; } catch { throw new Error("TARGET_ORIGIN_INVALID"); }
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

function redactAndBound(value: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /authorization|cookie|password|secret|token|credential|api.?key/i;
  const redact = (input: unknown, depth: number): unknown => {
    if (depth > 8) return "[TRUNCATED]";
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => redact(item, depth + 1));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as Record<string, unknown>).slice(0, 100).map(([key, child]) => [key, sensitive.test(key) ? "[REDACTED]" : redact(child, depth + 1)]));
    if (typeof input === "string") return input.slice(0, 2_048);
    return input;
  };
  const output = redact(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(canonicalJson(output)) > 32_768) throw new Error("EXECUTION_EVENT_TOO_LARGE");
  return output;
}

function subsetMatches(expected: Record<string, unknown>, observed: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => canonicalJson(observed[key]) === canonicalJson(value));
}
