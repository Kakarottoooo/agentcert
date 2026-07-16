export type MemberRole = "owner" | "admin" | "reviewer" | "viewer";
export type RunKind = "mcpbench" | "tripwire" | "release_gate" | "runtime" | "custom";
export type RunStatus = "running" | "passed" | "failed" | "needs_evidence" | "manual_review";
export type ActionDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type ActionStatus = "ALLOWED" | "DENIED" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "VERIFIED" | "VERIFICATION_FAILED";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type FailureReviewStatus = "confirmed" | "corrected";
export type EvidenceCompletenessStatus = "complete" | "partial" | "rejected";
export type LegalHoldStatus = "requested" | "approved" | "rejected" | "released";
export type ApiKeyScope =
  | "agents:read"
  | "runs:read"
  | "runs:write"
  | "events:write"
  | "actions:read"
  | "actions:write"
  | "evidence:read"
  | "evidence:write";
export type DeletionOutcome = "deleted" | "held" | "missing" | "failed";
export type FailureType =
  | "prompt_injection"
  | "wrong_click"
  | "timeout"
  | "verification_gap"
  | "silent_partial_success"
  | "network_failure"
  | "ui_drift"
  | "policy_or_approval"
  | "agent_connection"
  | "console_error"
  | "assertion_failure"
  | "unknown_failure";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Membership {
  organizationId: string;
  userId: string;
  role: MemberRole;
  createdAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface AgentRecord {
  id: string;
  projectId: string;
  externalId: string;
  name: string;
  version: string;
  framework?: string;
  allowedPermissions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  agentId?: string;
  externalId: string;
  kind: RunKind;
  status: RunStatus;
  score?: number;
  schemaVersion: string;
  startedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
  traceId?: string;
  rootSpanId?: string;
}

export interface EventRecord {
  id: string;
  projectId: string;
  runId: string;
  sequence: number;
  type: string;
  actor: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface ActionRecord {
  id: string;
  projectId: string;
  agentId?: string;
  externalId: string;
  principal: Record<string, unknown>;
  actionType: "SUBMIT" | "PAY" | "SEND" | "UPDATE";
  targetSystem: string;
  requestedPermissions: string[];
  amount?: number;
  currency?: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskScore: number;
  decision: ActionDecision;
  status: ActionStatus;
  policyVersion: string;
  reasons: string[];
  expectedState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
  verificationSuccess?: boolean;
  createdAt: string;
  updatedAt: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface ApprovalRecord {
  id: string;
  projectId: string;
  actionId: string;
  reviewerId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  projectId: string;
  runId?: string;
  actionId?: string;
  kind: string;
  schemaVersion: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceStorageUsage {
  count: number;
  bytes: number;
}

export interface EvidenceArtifactManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  kind: string;
}

export interface EvidenceArtifactManifest {
  schemaVersion: "agentcert.artifact_manifest.v0.1";
  entries: EvidenceArtifactManifestEntry[];
}

export interface EvidenceReconciliation {
  manifestVersion?: string;
  declared: number;
  matched: number;
  missing: string[];
  mismatched: Array<{ path: string; fields: string[] }>;
  unexpected: string[];
  legacy: boolean;
}

export interface EvidenceCompleteness {
  status: EvidenceCompletenessStatus;
  reasons: string[];
  evidenceCount: number;
  bytesUsed: number;
  runLimitBytes: number;
  remainingBytes: number;
  retentionDays: number;
  expiresAt?: string;
  legalHoldActive: boolean;
  reconciliation: EvidenceReconciliation;
}

export interface LegalHoldRequestRecord {
  id: string;
  projectId: string;
  status: LegalHoldStatus;
  reason: string;
  requestedBy: string;
  requestedByEmail?: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedByEmail?: string;
  reviewNote?: string;
  reviewedAt?: string;
  releasedBy?: string;
  releasedByEmail?: string;
  releaseNote?: string;
  releasedAt?: string;
}

export interface IncidentRecord {
  id: string;
  projectId: string;
  agentId?: string;
  runId?: string;
  actionId?: string;
  severity: IncidentSeverity;
  type: string;
  status: "open" | "resolved";
  summary: string;
  firstDivergence?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface FailureReviewRecord {
  id: string;
  projectId: string;
  runId: string;
  patternKey: string;
  suggestedType?: string;
  type: FailureType;
  status: FailureReviewStatus;
  reviewerId: string;
  reviewer: string;
  note?: string;
  confidence?: number;
  evidenceContext: {
    firstDivergenceSnippet?: string;
    screenshotPointer?: string;
    tracePointer?: string;
    stepIndex?: number;
  };
  taxonomyRationale: {
    primaryReason: string;
    supportingSignals: string[];
    contradictingSignals: string[];
    classifierLimitation?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  secretHash: string;
  createdBy: string;
  createdAt: string;
  scopes: ApiKeyScope[];
  lastUsedAt?: string;
  revokedAt?: string;
}

export type PublicApiKeyRecord = Omit<ApiKeyRecord, "secretHash">;

export interface AuthContext {
  kind: "user" | "api_key";
  userId?: string;
  email?: string;
  projectId?: string;
  apiKeyId?: string;
  scopes?: ApiKeyScope[];
}

export interface EvidenceDeletionRecord {
  id: string;
  projectId: string;
  evidenceId: string;
  runId?: string;
  actionId?: string;
  objectKey: string;
  fileName: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  outcome: DeletionOutcome;
  reason: string;
  error?: string;
  occurredAt: string;
}

export interface IdempotencyRecord {
  projectId: string;
  key: string;
  operation: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface WebhookRecord {
  id: string;
  projectId: string;
  url: string;
  eventTypes: string[];
  secretCiphertext: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PublicWebhookRecord extends Omit<WebhookRecord, "secretCiphertext"> {}

export interface WebhookDeliveryRecord {
  id: string;
  projectId: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: "delivered" | "failed";
  responseStatus?: number;
  error?: string;
  attemptedAt: string;
}

export type WebhookJobStatus = "pending" | "processing" | "retrying" | "delivered" | "dead_letter";
export type WebhookJobCounts = Record<WebhookJobStatus, number>;

export interface WebhookJobRecord {
  id: string;
  projectId: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: WebhookJobStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastResponseStatus?: number;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
}

export type SigningKeyStatus = "active" | "retired" | "revoked";

export interface SigningKeyRecord {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  status: SigningKeyStatus;
  createdAt: string;
  activatedAt: string;
  retiredAt?: string;
  revokedAt?: string;
}

export interface FailureQualityMetrics {
  schemaVersion: "agentcert.failure_quality_metrics.v0.1";
  totalFailures: number;
  reviewedFailures: number;
  confirmedFailures: number;
  correctedFailures: number;
  reviewCoverage: number;
  autoLabelPrecision: number;
  correctionRate: number;
  calculatedAt: string;
}

export interface PublicConfig {
  kind: "agentcert.control_plane_config";
  hosted: true;
  publicUrl: string;
  auth: {
    provider: "supabase" | "development";
    supabaseUrl?: string;
    supabasePublishableKey?: string;
    registrationOpen: boolean;
  };
}
