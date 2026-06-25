import type { ActionIntent, PolicyCondition, PolicyEvaluation, PolicyRule, RiskAssessment } from "./types.js";

export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    id: "po-over-1000-requires-approval",
    name: "Purchase orders over $1,000 require approval",
    description: "High-value purchase order submissions must be reviewed before mock execution.",
    actionTypes: ["SUBMIT"],
    effect: "REQUIRE_APPROVAL",
    enabled: true,
    conditions: [{ field: "amount", operator: "greaterThan", value: 1_000 }],
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
    conditions: [{ field: "environment", operator: "equals", value: "production" }],
  },
];

export function evaluatePolicy(
  action: ActionIntent,
  risk: RiskAssessment,
  policyRules: PolicyRule[] = DEFAULT_POLICY_RULES,
): PolicyEvaluation {
  if (action.environment === "production") {
    const productionBlock =
      policyRules.find((rule) => rule.id === "production-actions-blocked-in-demo") ??
      DEFAULT_POLICY_RULES.find((rule) => rule.id === "production-actions-blocked-in-demo");
    return {
      effect: "BLOCK",
      triggeredPolicies: productionBlock ? [productionBlock.id] : [],
      reasons: [productionBlock?.description ?? "Production actions are blocked in this local demo runtime."],
      requiresHumanApproval: false,
      blocked: true,
    };
  }

  const triggeredRules = policyRules.filter((rule) => matchesRule(action, rule));

  const blockRules = triggeredRules.filter((rule) => rule.effect === "BLOCK");
  if (blockRules.length > 0) {
    return {
      effect: "BLOCK",
      triggeredPolicies: blockRules.map((rule) => rule.id),
      reasons: blockRules.map((rule) => rule.description),
      requiresHumanApproval: false,
      blocked: true,
    };
  }

  const approvalRules = triggeredRules.filter((rule) => rule.effect === "REQUIRE_APPROVAL");
  if (approvalRules.length > 0) {
    return {
      effect: "REQUIRE_APPROVAL",
      triggeredPolicies: approvalRules.map((rule) => rule.id),
      reasons: approvalRules.map((rule) => rule.description),
      requiresHumanApproval: true,
      blocked: false,
    };
  }

  return {
    effect: "ALLOW",
    triggeredPolicies: triggeredRules.map((rule) => rule.id),
    reasons: risk.reasons,
    requiresHumanApproval: false,
    blocked: false,
  };
}

export function getPolicyRules(ids: string[], policyRules: PolicyRule[] = DEFAULT_POLICY_RULES): PolicyRule[] {
  const idSet = new Set(ids);
  return policyRules.filter((rule) => idSet.has(rule.id));
}

export function matchesRule(action: ActionIntent, rule: PolicyRule): boolean {
  if (!rule.enabled || !rule.actionTypes.includes(action.actionType)) {
    return false;
  }
  if (!rule.conditions || rule.conditions.length === 0) {
    return true;
  }
  return rule.conditions.every((condition) => matchesCondition(action, condition));
}

function matchesCondition(action: ActionIntent, condition: PolicyCondition): boolean {
  const actual = (action as unknown as Record<string, unknown>)[condition.field];
  switch (condition.operator) {
    case "equals":
      return actual === condition.value;
    case "notEquals":
      return actual !== condition.value;
    case "greaterThan":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "greaterThanOrEqual":
      return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
    case "lessThan":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "lessThanOrEqual":
      return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
    case "includes":
      return typeof actual === "string" && typeof condition.value === "string" && actual.includes(condition.value);
  }
}
