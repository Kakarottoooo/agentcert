export type MemberRole = "owner" | "admin" | "reviewer" | "viewer";
export type RunKind = "mcpbench" | "tripwire" | "release_gate" | "runtime" | "custom";
export type RunStatus = "running" | "passed" | "failed" | "needs_evidence" | "manual_review";
export type ActionDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type ActionStatus = "ALLOWED" | "DENIED" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "VERIFIED" | "VERIFICATION_FAILED";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type FailureReviewStatus = "confirmed" | "corrected";
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
