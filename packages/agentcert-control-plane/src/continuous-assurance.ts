import { createHash } from "node:crypto";
import { canonicalJson } from "./signing.js";
import type { ContinuousAssuranceContract } from "./types.js";

export const ASSURANCE_SCOPE_VERSION = "agentcert.assurance_scope.v0.1" as const;
export const ASSURANCE_CONTRACT_VERSION = "agentcert.continuous_assurance.v0.1" as const;

export type AssuranceTrigger = "pull_request" | "release" | "nightly";
export type AssuranceFreshnessStatus = "CURRENT" | "REVALIDATION_REQUIRED" | "SUSPENDED" | "EXPIRED";
export type AssuranceScopeComponent = "agent" | "model" | "prompt" | "tools" | "policy" | "scenarioSuite";

export interface AssuranceScopeInput {
  schemaVersion: typeof ASSURANCE_SCOPE_VERSION;
  agent: { id: string; version: string; artifactSha256?: string };
  model: { provider: string; name: string; version: string };
  prompt: { sha256: string };
  tools: { manifestSha256: string };
  policy: { id: string; version: string; sha256?: string };
  scenarioSuite: { id: string; version: string; sha256: string };
}

export interface AssuranceScopeChange {
  component: AssuranceScopeComponent;
  baselineSha256: string;
  observedSha256: string;
}

export interface AssuranceReconciliation {
  outcome: "current" | "would_require_revalidation" | "revalidation_required";
  authoritative: boolean;
  nextStatus: "CURRENT" | "REVALIDATION_REQUIRED";
  reasonCode: "scope_matches" | "scope_changed" | "evaluation_failed";
  changes: AssuranceScopeChange[];
}

const COMPONENTS: AssuranceScopeComponent[] = ["agent", "model", "prompt", "tools", "policy", "scenarioSuite"];

export function normalizeAssuranceScope(input: unknown): AssuranceScopeInput {
  const value = objectValue(input, "scope");
  if (value.schemaVersion !== ASSURANCE_SCOPE_VERSION) throw new Error(`scope.schemaVersion must be ${ASSURANCE_SCOPE_VERSION}.`);
  const agent = objectValue(value.agent, "scope.agent");
  const model = objectValue(value.model, "scope.model");
  const prompt = objectValue(value.prompt, "scope.prompt");
  const tools = objectValue(value.tools, "scope.tools");
  const policy = objectValue(value.policy, "scope.policy");
  const scenarioSuite = objectValue(value.scenarioSuite, "scope.scenarioSuite");
  return {
    schemaVersion: ASSURANCE_SCOPE_VERSION,
    agent: {
      id: textValue(agent.id, "scope.agent.id"),
      version: textValue(agent.version, "scope.agent.version"),
      artifactSha256: optionalSha256(agent.artifactSha256, "scope.agent.artifactSha256"),
    },
    model: {
      provider: textValue(model.provider, "scope.model.provider"),
      name: textValue(model.name, "scope.model.name"),
      version: textValue(model.version, "scope.model.version"),
    },
    prompt: { sha256: sha256Value(prompt.sha256, "scope.prompt.sha256") },
    tools: { manifestSha256: sha256Value(tools.manifestSha256, "scope.tools.manifestSha256") },
    policy: {
      id: textValue(policy.id, "scope.policy.id"),
      version: textValue(policy.version, "scope.policy.version"),
      sha256: optionalSha256(policy.sha256, "scope.policy.sha256"),
    },
    scenarioSuite: {
      id: textValue(scenarioSuite.id, "scope.scenarioSuite.id"),
      version: textValue(scenarioSuite.version, "scope.scenarioSuite.version"),
      sha256: sha256Value(scenarioSuite.sha256, "scope.scenarioSuite.sha256"),
    },
  };
}

export function assuranceScopeFingerprint(scope: AssuranceScopeInput): string {
  return digest(normalizeAssuranceScope(scope));
}

export function compareAssuranceScopes(baseline: AssuranceScopeInput, observed: AssuranceScopeInput): AssuranceScopeChange[] {
  const normalizedBaseline = normalizeAssuranceScope(baseline);
  const normalizedObserved = normalizeAssuranceScope(observed);
  return COMPONENTS.flatMap((component) => {
    const baselineSha256 = digest(normalizedBaseline[component]);
    const observedSha256 = digest(normalizedObserved[component]);
    return baselineSha256 === observedSha256 ? [] : [{ component, baselineSha256, observedSha256 }];
  });
}

export function reconcileContinuousAssurance(input: {
  baseline: AssuranceScopeInput;
  observed: AssuranceScopeInput;
  trigger: AssuranceTrigger;
  runStatus: "passed" | "failed" | "needs_evidence" | "manual_review";
}): AssuranceReconciliation {
  const changes = compareAssuranceScopes(input.baseline, input.observed);
  const authoritative = input.trigger !== "pull_request";
  const failed = input.runStatus !== "passed";
  if (!failed && changes.length === 0) {
    return { outcome: "current", authoritative, nextStatus: "CURRENT", reasonCode: "scope_matches", changes };
  }
  const reasonCode = failed ? "evaluation_failed" : "scope_changed";
  if (!authoritative) {
    return { outcome: "would_require_revalidation", authoritative, nextStatus: "CURRENT", reasonCode, changes };
  }
  return { outcome: "revalidation_required", authoritative, nextStatus: "REVALIDATION_REQUIRED", reasonCode, changes };
}

export function createContinuousAssuranceContract(
  input: unknown,
  now: string,
  supersedesCaseId?: string,
): ContinuousAssuranceContract {
  const scope = normalizeAssuranceScope(input);
  return {
    schemaVersion: ASSURANCE_CONTRACT_VERSION,
    scope,
    scopeFingerprintSha256: assuranceScopeFingerprint(scope),
    freshness: {
      status: "REVALIDATION_REQUIRED",
      reasonCode: "initial_review_pending",
      reason: "The declared scope has not yet received an independent assurance decision.",
      changedComponents: [],
      evaluatedAt: now,
    },
    supersedesCaseId,
    metrics: emptyContinuousAssuranceMetrics(),
  };
}

export function markContinuousAssuranceCurrent(contract: ContinuousAssuranceContract, now: string): ContinuousAssuranceContract {
  return {
    ...contract,
    freshness: {
      status: "CURRENT",
      reasonCode: "scope_matches",
      reason: "The declared scope matches the independently reviewed assurance baseline.",
      changedComponents: [],
      evaluatedAt: now,
    },
    validatedAt: now,
    currentSince: now,
    prospective: undefined,
  };
}

export function applyContinuousAssuranceObservation(
  contract: ContinuousAssuranceContract,
  input: {
    observed: AssuranceScopeInput;
    trigger: AssuranceTrigger;
    runStatus: "passed" | "failed" | "needs_evidence" | "manual_review";
    runId: string;
    observedAt: string;
  },
): { contract: ContinuousAssuranceContract; reconciliation: AssuranceReconciliation } {
  const observed = normalizeAssuranceScope(input.observed);
  const reconciliation = reconcileContinuousAssurance({ baseline: contract.scope, observed, trigger: input.trigger, runStatus: input.runStatus });
  const passed = input.runStatus === "passed";
  const metrics = {
    ...contract.metrics,
    totalEvaluations: contract.metrics.totalEvaluations + 1,
    passedEvaluations: contract.metrics.passedEvaluations + (passed ? 1 : 0),
    failedEvaluations: contract.metrics.failedEvaluations + (passed ? 0 : 1),
    revalidationRequiredCount: contract.metrics.revalidationRequiredCount + (reconciliation.outcome === "revalidation_required" ? 1 : 0),
    prospectiveChangeCount: contract.metrics.prospectiveChangeCount + (reconciliation.outcome === "would_require_revalidation" ? 1 : 0),
    triggerCounts: {
      ...contract.metrics.triggerCounts,
      [input.trigger]: contract.metrics.triggerCounts[input.trigger] + 1,
    },
    lastEvaluationAt: input.observedAt,
  };
  const common: ContinuousAssuranceContract = {
    ...contract,
    lastObservedScope: observed,
    lastObservedFingerprintSha256: assuranceScopeFingerprint(observed),
    lastRunId: input.runId,
    lastTrigger: input.trigger,
    metrics,
  };
  if (!reconciliation.authoritative) {
    return {
      reconciliation,
      contract: {
        ...common,
        prospective: {
          runId: input.runId,
          observedAt: input.observedAt,
          changes: reconciliation.changes,
          outcome: reconciliation.outcome === "current" ? "current" : "would_require_revalidation",
        },
      },
    };
  }
  if (reconciliation.outcome === "revalidation_required") {
    const next: ContinuousAssuranceContract = {
      ...common,
      freshness: {
        status: "REVALIDATION_REQUIRED",
        reasonCode: reconciliation.reasonCode,
        reason: reconciliation.reasonCode === "scope_changed"
          ? `The deployed assurance scope changed: ${reconciliation.changes.map((item) => item.component).join(", ")}.`
          : `The ${input.trigger} assurance evaluation did not pass.`,
        changedComponents: reconciliation.changes,
        evaluatedAt: input.observedAt,
      },
      prospective: undefined,
    };
    return { contract: next, reconciliation };
  }
  if (contract.freshness.status !== "CURRENT") {
    return { contract: { ...common, prospective: undefined }, reconciliation };
  }
  const next: ContinuousAssuranceContract = {
    ...common,
    freshness: {
      status: "CURRENT",
      reasonCode: "scope_matches",
      reason: `The ${input.trigger} evaluation passed against the current assurance scope.`,
      changedComponents: [],
      evaluatedAt: input.observedAt,
    },
    prospective: undefined,
  };
  return { contract: next, reconciliation };
}

export function forceContinuousAssuranceFreshness(
  contract: ContinuousAssuranceContract,
  status: "SUSPENDED" | "EXPIRED" | "REVALIDATION_REQUIRED",
  reasonCode: ContinuousAssuranceContract["freshness"]["reasonCode"],
  reason: string,
  now: string,
): ContinuousAssuranceContract {
  return {
    ...contract,
    freshness: { status, reasonCode, reason, changedComponents: contract.freshness.changedComponents, evaluatedAt: now },
  };
}

function emptyContinuousAssuranceMetrics(): ContinuousAssuranceContract["metrics"] {
  return {
    totalEvaluations: 0,
    passedEvaluations: 0,
    failedEvaluations: 0,
    revalidationRequiredCount: 0,
    prospectiveChangeCount: 0,
    triggerCounts: { pull_request: 0, release: 0, nightly: 0 },
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function textValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(`${name} must be a non-empty string up to 256 characters.`);
  return value.trim();
}

function sha256Value(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function optionalSha256(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : sha256Value(value, name);
}
