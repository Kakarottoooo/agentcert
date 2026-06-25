import type {
  ActionIntent,
  ApprovalRequest,
  AuditEvent,
  MockPurchaseOrder,
  PolicyRule,
  RiskAssessment,
  VerificationResult,
} from "./types.js";

export interface ActionGatewayStore {
  actions: Map<string, ActionIntent>;
  riskAssessments: Map<string, RiskAssessment>;
  approvals: Map<string, ApprovalRequest>;
  verifications: Map<string, VerificationResult>;
  auditEvents: AuditEvent[];
  purchaseOrders: Map<string, MockPurchaseOrder>;
  policyRulesByAction: Map<string, PolicyRule[]>;
}

export const store: ActionGatewayStore = {
  actions: new Map(),
  riskAssessments: new Map(),
  approvals: new Map(),
  verifications: new Map(),
  auditEvents: [],
  purchaseOrders: new Map(),
  policyRulesByAction: new Map(),
};

let sequence = 0;

export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(6, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function resetActionGatewayStore(): void {
  sequence = 0;
  store.actions.clear();
  store.riskAssessments.clear();
  store.approvals.clear();
  store.verifications.clear();
  store.auditEvents = [];
  store.purchaseOrders.clear();
  store.policyRulesByAction.clear();
}
