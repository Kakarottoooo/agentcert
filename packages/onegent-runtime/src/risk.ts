import type { ActionIntent, RiskAssessment, RiskLevel } from "./types.js";
import { nextId, nowIso } from "./store.js";

const PURCHASE_ORDER_APPROVAL_THRESHOLD = 1_000;

export function assessRisk(action: ActionIntent): RiskAssessment {
  const reasons: string[] = [];
  const triggeredPolicies: string[] = [];
  let riskLevel: RiskLevel = "LOW";
  let riskScore = 20;

  if (action.actionType === "PAY") {
    riskLevel = "HIGH";
    riskScore = 85;
    reasons.push("Payment actions can move money and require human approval in the demo runtime.");
    triggeredPolicies.push("payment-actions-require-approval");
  }

  if (action.actionType === "SEND" && action.recipient && !action.recipient.endsWith("@example.local")) {
    riskLevel = maxRisk(riskLevel, "HIGH");
    riskScore = Math.max(riskScore, 75);
    reasons.push("External send actions can disclose business data and require human approval.");
    triggeredPolicies.push("external-send-requires-approval");
  }

  if (action.actionType === "SUBMIT" && (action.amount ?? 0) > PURCHASE_ORDER_APPROVAL_THRESHOLD) {
    riskLevel = maxRisk(riskLevel, "HIGH");
    riskScore = Math.max(riskScore, 80);
    reasons.push("Purchase orders over $1,000 require human approval.");
    triggeredPolicies.push("po-over-1000-requires-approval");
  }

  if (action.actionType === "UPDATE" && action.fieldsChanged.length > 0) {
    riskLevel = maxRisk(riskLevel, "MEDIUM");
    riskScore = Math.max(riskScore, 45);
    reasons.push("Update actions modify business records and require verification.");
  }

  if (action.environment === "production") {
    riskLevel = maxRisk(riskLevel, "CRITICAL");
    riskScore = Math.max(riskScore, 95);
    reasons.push("Production actions are blocked in this local demo runtime.");
    triggeredPolicies.push("production-actions-blocked-in-demo");
  }

  if (reasons.length === 0) {
    reasons.push("No high-risk demo policy matched this action.");
  }

  return {
    id: nextId("risk"),
    actionIntentId: action.id,
    riskLevel,
    riskScore,
    reasons,
    triggeredPolicies,
    requiresHumanApproval: riskLevel === "HIGH" || riskLevel === "CRITICAL",
    createdAt: nowIso(),
  };
}

function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}
