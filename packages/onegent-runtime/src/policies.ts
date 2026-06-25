import type { ActionIntent, PolicyEvaluation, PolicyRule, RiskAssessment } from "./types.js";

export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    id: "po-over-1000-requires-approval",
    name: "Purchase orders over $1,000 require approval",
    description: "High-value purchase order submissions must be reviewed before mock execution.",
    actionTypes: ["SUBMIT"],
    effect: "REQUIRE_APPROVAL",
    enabled: true,
  },
  {
    id: "payment-actions-require-approval",
    name: "Payment actions require approval",
    description: "The demo runtime never executes real payments and requires approval for mock payment actions.",
    actionTypes: ["PAY"],
    effect: "REQUIRE_APPROVAL",
    enabled: true,
  },
  {
    id: "external-send-requires-approval",
    name: "External send actions require approval",
    description: "Outbound communications to non-demo recipients require approval.",
    actionTypes: ["SEND"],
    effect: "REQUIRE_APPROVAL",
    enabled: true,
  },
  {
    id: "production-actions-blocked-in-demo",
    name: "Production actions are blocked in demo mode",
    description: "This package is local-only and will not perform production actions.",
    actionTypes: ["SUBMIT", "PAY", "SEND", "UPDATE"],
    effect: "BLOCK",
    enabled: true,
  },
];

export function evaluatePolicy(action: ActionIntent, risk: RiskAssessment): PolicyEvaluation {
  const triggeredRules = DEFAULT_POLICY_RULES.filter(
    (rule) => rule.enabled && risk.triggeredPolicies.includes(rule.id) && rule.actionTypes.includes(action.actionType),
  );

  if (action.environment === "production") {
    const productionBlock = DEFAULT_POLICY_RULES.find((rule) => rule.id === "production-actions-blocked-in-demo");
    return {
      effect: "BLOCK",
      triggeredPolicies: productionBlock ? [productionBlock.id] : [],
      reasons: ["Production actions are blocked in this local demo runtime."],
      requiresHumanApproval: false,
      blocked: true,
    };
  }

  const hasApprovalRule = triggeredRules.some((rule) => rule.effect === "REQUIRE_APPROVAL");
  if (hasApprovalRule || risk.requiresHumanApproval) {
    return {
      effect: "REQUIRE_APPROVAL",
      triggeredPolicies: triggeredRules.map((rule) => rule.id),
      reasons: risk.reasons,
      requiresHumanApproval: true,
      blocked: false,
    };
  }

  return {
    effect: "ALLOW",
    triggeredPolicies: [],
    reasons: risk.reasons,
    requiresHumanApproval: false,
    blocked: false,
  };
}

export function getPolicyRules(ids: string[]): PolicyRule[] {
  const idSet = new Set(ids);
  return DEFAULT_POLICY_RULES.filter((rule) => idSet.has(rule.id));
}
