export type ActionType = "SUBMIT" | "PAY" | "SEND" | "UPDATE";

export type ActionEnvironment = "demo" | "staging" | "production";

export type ActionIntentStatus =
  | "CAPTURED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTED"
  | "VERIFIED"
  | "FAILED_VERIFICATION"
  | "CANCELLED";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PolicyEffect = "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export type VerificationMethod = "MOCK" | "LOCAL_MOCK_ERP" | "LOCAL_ADAPTER";

export interface ActionFieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface ActionIntent {
  id: string;
  workspaceId: string;
  workflowId: string;
  sourceAgentName: string;
  sourceAgentRunId?: string;
  actionType: ActionType;
  targetSystem: string;
  targetUrl?: string;
  environment: ActionEnvironment;
  title: string;
  description: string;
  businessObjectType: string;
  businessObjectId: string;
  amount?: number;
  currency?: string;
  recipient?: string;
  vendorName?: string;
  beforeState: Record<string, unknown>;
  proposedAfterState: Record<string, unknown>;
  fieldsChanged: ActionFieldChange[];
  rawAgentReasoningSummary?: string;
  createdAt: string;
  status: ActionIntentStatus;
}

export interface CreateActionIntentInput {
  workspaceId?: string;
  workflowId?: string;
  sourceAgentName: string;
  sourceAgentRunId?: string;
  actionType: ActionType;
  targetSystem: string;
  targetUrl?: string;
  environment?: ActionEnvironment;
  title: string;
  description: string;
  businessObjectType: string;
  businessObjectId: string;
  amount?: number;
  currency?: string;
  recipient?: string;
  vendorName?: string;
  beforeState?: Record<string, unknown>;
  proposedAfterState?: Record<string, unknown>;
  fieldsChanged?: ActionFieldChange[];
  rawAgentReasoningSummary?: string;
}

export interface RiskAssessment {
  id: string;
  actionIntentId: string;
  riskLevel: RiskLevel;
  riskScore: number;
  reasons: string[];
  triggeredPolicies: string[];
  requiresHumanApproval: boolean;
  createdAt: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  actionTypes: ActionType[];
  effect: PolicyEffect;
  enabled: boolean;
  conditions?: PolicyCondition[];
}

export interface PolicyCondition {
  field: string;
  operator: "equals" | "notEquals" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual" | "includes";
  value: unknown;
}

export interface PolicyConfig {
  schemaVersion: "1";
  rules: PolicyRule[];
}

export interface PolicyEvaluation {
  effect: PolicyEffect;
  triggeredPolicies: string[];
  reasons: string[];
  requiresHumanApproval: boolean;
  blocked: boolean;
}

export interface PolicyEngine {
  evaluate(action: ActionIntent, risk: RiskAssessment, rules: PolicyRule[]): PolicyEvaluation;
}

export interface ApprovalRequest {
  id: string;
  actionIntentId: string;
  riskAssessmentId: string;
  requestedBy: string;
  assignedTo: string;
  status: ApprovalStatus;
  reviewerComment?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface ApprovalAdapterDecision {
  approved?: boolean;
  reviewerId?: string;
  reviewerComment?: string;
}

export interface ApprovalAdapterRequest {
  action: ActionIntent;
  risk: RiskAssessment;
  policy: PolicyEvaluation;
  approvalRequest: ApprovalRequest;
}

export interface ApprovalAdapter {
  name: string;
  requestApproval(input: ApprovalAdapterRequest): ApprovalAdapterDecision | void | Promise<ApprovalAdapterDecision | void>;
}

export interface VerificationResult {
  id: string;
  actionIntentId: string;
  expectedState: Record<string, unknown>;
  observedState: Record<string, unknown>;
  success: boolean;
  differences: string[];
  verificationMethod: VerificationMethod;
  createdAt: string;
}

export type AuditEventType =
  | "ACTION_CAPTURED"
  | "RISK_ASSESSED"
  | "POLICY_EVALUATED"
  | "APPROVAL_REQUESTED"
  | "ACTION_APPROVED"
  | "ACTION_REJECTED"
  | "MOCK_EXECUTION_STARTED"
  | "MOCK_EXECUTION_COMPLETED"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "AUDIT_PACKET_GENERATED";

export interface AuditEvent {
  id: string;
  actionIntentId: string;
  eventType: AuditEventType;
  actorType: "AGENT" | "HUMAN" | "SYSTEM";
  actorId: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MockPurchaseOrder {
  id: string;
  vendor: string;
  amount: number;
  currency: string;
  status: "DRAFT" | "SUBMITTED";
  vendorApproved: boolean;
  lineItem: string;
  lastUpdatedAt: string;
  actionIntentId?: string;
}

export interface ActionReview {
  action: ActionIntent;
  riskAssessment: RiskAssessment;
  approvalRequest?: ApprovalRequest;
  verificationResult?: VerificationResult;
  auditEvents: AuditEvent[];
  policyRules: PolicyRule[];
  blocked: boolean;
}

export interface ActionExecutionSummary {
  method: VerificationMethod;
  status: "NOT_EXECUTED" | "COMPLETED";
  targetSystem: string;
  previousState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
}

export interface LocalActionAdapterResult {
  method?: VerificationMethod;
  targetSystem?: string;
  previousState?: Record<string, unknown>;
  observedState: Record<string, unknown>;
}

export interface LocalActionAdapter {
  name: string;
  execute(action: ActionIntent): LocalActionAdapterResult | Promise<LocalActionAdapterResult>;
}

export interface ActionAuditPacket {
  demo: true;
  product: "AgentCert Onegent Runtime";
  scenario: string;
  actionIntent: ActionIntent;
  riskAssessment: RiskAssessment;
  triggeredPolicies: PolicyRule[];
  approvalRequest?: ApprovalRequest;
  execution: ActionExecutionSummary;
  verificationResult?: VerificationResult;
  auditEvents: AuditEvent[];
  disclaimer: string;
}

export interface AuditStore {
  name: string;
  writeAuditPacket(packet: ActionAuditPacket): void | Promise<void>;
}

export interface ProcurementWalkthroughState {
  purchaseOrder: MockPurchaseOrder;
  review: ActionReview;
  auditPacket?: ActionAuditPacket;
}
