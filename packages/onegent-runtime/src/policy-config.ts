import { readFile } from "node:fs/promises";
import type { ActionType, PolicyConfig, PolicyCondition, PolicyEffect, PolicyRule } from "./types.js";

const ACTION_TYPES: ActionType[] = ["SUBMIT", "PAY", "SEND", "UPDATE"];
const EFFECTS: PolicyEffect[] = ["ALLOW", "REQUIRE_APPROVAL", "BLOCK"];
const OPERATORS: PolicyCondition["operator"][] = [
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "includes",
];

export async function loadPolicyConfig(path: string): Promise<PolicyRule[]> {
  const raw = await readFile(path, "utf8");
  return parsePolicyConfig(JSON.parse(raw));
}

export function parsePolicyConfig(input: unknown): PolicyRule[] {
  const config = asRecord(input);
  if (config.schemaVersion !== "1") {
    throw new Error("Policy config schemaVersion must be \"1\".");
  }
  if (!Array.isArray(config.rules)) {
    throw new Error("Policy config must include a rules array.");
  }
  return config.rules.map(parseRule);
}

export function buildPolicyConfig(rules: PolicyRule[]): PolicyConfig {
  return {
    schemaVersion: "1",
    rules,
  };
}

function parseRule(input: unknown): PolicyRule {
  const rule = asRecord(input);
  const actionTypes = parseActionTypes(rule.actionTypes);
  const effect = parseEffect(rule.effect);
  const conditions = Array.isArray(rule.conditions) ? rule.conditions.map(parseCondition) : undefined;
  const id = stringField(rule, "id");

  return {
    id,
    name: stringField(rule, "name"),
    description: stringField(rule, "description"),
    actionTypes,
    effect,
    enabled: rule.enabled !== false,
    conditions,
  };
}

function parseCondition(input: unknown): PolicyCondition {
  const condition = asRecord(input);
  const operator = condition.operator;
  if (!OPERATORS.includes(operator as PolicyCondition["operator"])) {
    throw new Error(`Unsupported policy condition operator: ${String(operator)}.`);
  }
  return {
    field: stringField(condition, "field"),
    operator: operator as PolicyCondition["operator"],
    value: condition.value,
  };
}

function parseActionTypes(input: unknown): ActionType[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Policy rule actionTypes must be a non-empty array.");
  }
  return input.map((value) => {
    if (!ACTION_TYPES.includes(value as ActionType)) {
      throw new Error(`Unsupported action type in policy config: ${String(value)}.`);
    }
    return value as ActionType;
  });
}

function parseEffect(input: unknown): PolicyEffect {
  if (!EFFECTS.includes(input as PolicyEffect)) {
    throw new Error(`Unsupported policy effect: ${String(input)}.`);
  }
  return input as PolicyEffect;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Policy rule field ${field} must be a non-empty string.`);
  }
  return value;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}
