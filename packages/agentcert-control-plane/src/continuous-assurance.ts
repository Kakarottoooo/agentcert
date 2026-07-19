import { createHash } from "node:crypto";
import { canonicalJson } from "./signing.js";
import type {
  ContinuousAssuranceAdoptionKit,
  ContinuousAssuranceContract,
  ContinuousAssuranceHistoryEvent,
  ContinuousAssuranceMetrics,
} from "./types.js";

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
const HISTORY_LIMIT = 500;

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
  const contract: ContinuousAssuranceContract = {
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
    reminders: { expiryThresholdDaysSent: [] },
    metrics: emptyContinuousAssuranceMetrics(),
  };
  return withHistory(contract, {
    kind: "contract_created", status: "REVALIDATION_REQUIRED", occurredAt: now,
    reasonCode: "initial_review_pending", reason: contract.freshness.reason, changedComponents: [],
  });
}

export function markContinuousAssuranceCurrent(contract: ContinuousAssuranceContract, now: string): ContinuousAssuranceContract {
  const pendingCycle = contract.revalidation && !contract.revalidation.completedAt ? contract.revalidation : undefined;
  const durationMs = pendingCycle ? Math.max(0, Date.parse(now) - Date.parse(pendingCycle.startedAt)) : undefined;
  const metrics = normalizedMetrics(contract.metrics);
  const next: ContinuousAssuranceContract = {
    ...contract,
    freshness: {
      status: "CURRENT",
      reasonCode: "scope_matches",
      reason: "The declared scope matches the independently reviewed assurance baseline.",
      changedComponents: [],
      evaluatedAt: now,
    },
    validatedAt: now,
    firstCurrentAt: contract.firstCurrentAt ?? now,
    currentSince: now,
    revalidation: pendingCycle ? { ...pendingCycle, completedAt: now, durationMs } : contract.revalidation,
    metrics: pendingCycle ? {
      ...metrics,
      revalidationCompletedCount: metrics.revalidationCompletedCount + 1,
      totalRevalidationDurationMs: metrics.totalRevalidationDurationMs + durationMs!,
      lastRevalidationDurationMs: durationMs,
    } : metrics,
    prospective: undefined,
  };
  return withHistory(next, {
    kind: "current", status: "CURRENT", occurredAt: now, reasonCode: "scope_matches",
    reason: next.freshness.reason, changedComponents: [],
  });
}

export function createContinuousAssuranceRevalidation(
  previous: ContinuousAssuranceContract,
  scope: AssuranceScopeInput,
  now: string,
  sourceCaseId: string,
): ContinuousAssuranceContract {
  const base = createContinuousAssuranceContract(scope, now, sourceCaseId);
  const previousMetrics = normalizedMetrics(previous.metrics);
  const cycleNumber = previousMetrics.revalidationStartedCount + 1;
  const next: ContinuousAssuranceContract = {
    ...base,
    firstCurrentAt: previous.firstCurrentAt ?? previous.currentSince,
    history: previous.history,
    historyTruncated: previous.historyTruncated,
    metrics: { ...previousMetrics, revalidationStartedCount: cycleNumber },
    revalidation: { cycleNumber, sourceCaseId, startedAt: now },
  };
  return withHistory(next, {
    kind: "revalidation_started", status: "REVALIDATION_REQUIRED", occurredAt: now,
    reasonCode: "revalidation_started", reason: `Revalidation cycle ${cycleNumber} started for a changed or stale scope.`,
    changedComponents: previous.freshness.changedComponents.map((item) => item.component),
  });
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
  const previousMetrics = normalizedMetrics(contract.metrics);
  const metrics = {
    ...previousMetrics,
    totalEvaluations: previousMetrics.totalEvaluations + 1,
    passedEvaluations: previousMetrics.passedEvaluations + (passed ? 1 : 0),
    failedEvaluations: previousMetrics.failedEvaluations + (passed ? 0 : 1),
    revalidationRequiredCount: previousMetrics.revalidationRequiredCount + (reconciliation.outcome === "revalidation_required" ? 1 : 0),
    prospectiveChangeCount: previousMetrics.prospectiveChangeCount + (reconciliation.outcome === "would_require_revalidation" ? 1 : 0),
    triggerCounts: {
      ...previousMetrics.triggerCounts,
      [input.trigger]: previousMetrics.triggerCounts[input.trigger] + 1,
    },
    lastEvaluationAt: input.observedAt,
  };
  const firstAuthoritativeCurrent = contract.adoption
    && contract.freshness.status === "CURRENT"
    && reconciliation.authoritative
    && reconciliation.outcome === "current"
    && !contract.adoption.firstAuthoritativeCurrentAt
      ? {
          ...contract.adoption,
          firstAuthoritativeCurrentAt: input.observedAt,
          firstAuthoritativeRunId: input.runId,
          timeToFirstCurrentMs: Math.max(0, Date.parse(input.observedAt) - Date.parse(contract.adoption.activatedAt)),
        }
      : contract.adoption;
  const common: ContinuousAssuranceContract = {
    ...contract,
    lastObservedScope: observed,
    lastObservedFingerprintSha256: assuranceScopeFingerprint(observed),
    lastRunId: input.runId,
    lastTrigger: input.trigger,
    metrics,
    adoption: firstAuthoritativeCurrent,
  };
  if (!reconciliation.authoritative) {
    const prospective: ContinuousAssuranceContract = {
      ...common,
      prospective: {
        runId: input.runId,
        observedAt: input.observedAt,
        changes: reconciliation.changes,
        outcome: reconciliation.outcome === "current" ? "current" : "would_require_revalidation",
      },
    };
    return {
      reconciliation,
      contract: reconciliation.outcome === "would_require_revalidation"
        ? withHistory(prospective, {
          kind: "prospective_change", status: contract.freshness.status, occurredAt: input.observedAt,
          reasonCode: reconciliation.reasonCode, reason: "A pull request would invalidate the current assurance scope if released.",
          runId: input.runId, trigger: input.trigger, changedComponents: reconciliation.changes.map((item) => item.component),
        })
        : prospective,
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
    const meaningfulChange = contract.freshness.status !== "REVALIDATION_REQUIRED"
      || contract.freshness.reasonCode !== reconciliation.reasonCode
      || contract.freshness.changedComponents.map((item) => item.component).join(",") !== reconciliation.changes.map((item) => item.component).join(",");
    return {
      contract: meaningfulChange ? withHistory(next, {
        kind: "revalidation_required", status: "REVALIDATION_REQUIRED", occurredAt: input.observedAt,
        reasonCode: reconciliation.reasonCode, reason: next.freshness.reason, runId: input.runId, trigger: input.trigger,
        changedComponents: reconciliation.changes.map((item) => item.component),
      }) : next,
      reconciliation,
    };
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
  return {
    contract: withHistory(next, {
      kind: "current", status: "CURRENT", occurredAt: input.observedAt,
      reasonCode: "scope_matches", reason: next.freshness.reason, runId: input.runId, trigger: input.trigger,
      changedComponents: [],
    }),
    reconciliation,
  };
}

export function forceContinuousAssuranceFreshness(
  contract: ContinuousAssuranceContract,
  status: "SUSPENDED" | "EXPIRED" | "REVALIDATION_REQUIRED",
  reasonCode: ContinuousAssuranceContract["freshness"]["reasonCode"],
  reason: string,
  now: string,
): ContinuousAssuranceContract {
  const next: ContinuousAssuranceContract = {
    ...contract,
    freshness: { status, reasonCode, reason, changedComponents: contract.freshness.changedComponents, evaluatedAt: now },
  };
  return withHistory(next, {
    kind: status === "EXPIRED" ? "expired" : status === "SUSPENDED" ? "suspended" : "revalidation_required",
    status, occurredAt: now, reasonCode, reason,
    changedComponents: contract.freshness.changedComponents.map((item) => item.component),
  });
}

export function buildContinuousAssuranceAdoptionKit(input: {
  contract: ContinuousAssuranceContract;
  projectId: string;
  assuranceCaseId: string;
  generatedAt: string;
}): ContinuousAssuranceAdoptionKit {
  const scopeContent = `${JSON.stringify(JSON.parse(canonicalJson(normalizeAssuranceScope(input.contract.scope))), null, 2)}\n`;
  const workflowContent = continuousAssuranceWorkflow(input.projectId, input.assuranceCaseId);
  const readmeContent = continuousAssuranceReadme(input.assuranceCaseId, input.contract.scopeFingerprintSha256);
  return {
    schemaVersion: "agentcert.continuous_assurance_kit.v0.1",
    projectId: input.projectId,
    assuranceCaseId: input.assuranceCaseId,
    scopeFingerprintSha256: input.contract.scopeFingerprintSha256,
    generatedAt: input.generatedAt,
    requiredSecret: "AGENTCERT_API_KEY",
    triggerPolicy: { pullRequest: "prospective", release: "authoritative", nightly: "authoritative" },
    files: [
      adoptionFile("agentcert.assurance-scope.json", "application/json", scopeContent),
      adoptionFile(".github/workflows/agentcert-continuous-assurance.yml", "text/yaml", workflowContent),
      adoptionFile("AGENTCERT-CONTINUOUS-ASSURANCE.md", "text/markdown", readmeContent),
    ],
  };
}

export function markContinuousAssuranceAdopted(
  contract: ContinuousAssuranceContract,
  now: string,
  actorId: string,
  workflowSha256: string,
): ContinuousAssuranceContract {
  if (contract.adoption) return contract;
  const next: ContinuousAssuranceContract = {
    ...contract,
    adoption: {
      schemaVersion: "agentcert.continuous_assurance_adoption.v0.1",
      activatedAt: now,
      activatedBy: actorId,
      workflowSha256,
    },
  };
  return withHistory(next, {
    kind: "ci_activated", status: contract.freshness.status, occurredAt: now,
    reasonCode: "ci_activated", reason: "The continuous assurance CI kit was generated from the issued review.",
    changedComponents: [],
  });
}

export function markContinuousAssuranceExpiryReminder(
  contract: ContinuousAssuranceContract,
  thresholdDays: 30 | 7 | 1,
  now: string,
): ContinuousAssuranceContract {
  const sent = contract.reminders?.expiryThresholdDaysSent ?? [];
  if (sent.includes(thresholdDays)) return contract;
  const crossedThresholds = ([30, 7, 1] as const).filter((days) => days >= thresholdDays);
  const next: ContinuousAssuranceContract = {
    ...contract,
    reminders: {
      expiryThresholdDaysSent: [...new Set([...sent, ...crossedThresholds])].sort((left, right) => right - left),
      lastExpiryReminderAt: now,
    },
  };
  return withHistory(next, {
    kind: "expiry_warning", status: contract.freshness.status, occurredAt: now,
    reasonCode: "expiry_warning", reason: `The current assurance expires within ${thresholdDays} day${thresholdDays === 1 ? "" : "s"}.`,
    changedComponents: [], remainingDays: thresholdDays,
  });
}

function emptyContinuousAssuranceMetrics(): ContinuousAssuranceContract["metrics"] {
  return {
    totalEvaluations: 0,
    passedEvaluations: 0,
    failedEvaluations: 0,
    revalidationRequiredCount: 0,
    prospectiveChangeCount: 0,
    triggerCounts: { pull_request: 0, release: 0, nightly: 0 },
    revalidationStartedCount: 0,
    revalidationCompletedCount: 0,
    totalRevalidationDurationMs: 0,
  };
}

function normalizedMetrics(metrics: ContinuousAssuranceMetrics): ContinuousAssuranceMetrics {
  return {
    ...metrics,
    triggerCounts: {
      pull_request: metrics.triggerCounts?.pull_request ?? 0,
      release: metrics.triggerCounts?.release ?? 0,
      nightly: metrics.triggerCounts?.nightly ?? 0,
    },
    revalidationStartedCount: metrics.revalidationStartedCount ?? 0,
    revalidationCompletedCount: metrics.revalidationCompletedCount ?? 0,
    totalRevalidationDurationMs: metrics.totalRevalidationDurationMs ?? 0,
  };
}

function withHistory(contract: ContinuousAssuranceContract, event: ContinuousAssuranceHistoryEvent): ContinuousAssuranceContract {
  const history = [...(contract.history ?? []), event];
  const overflow = Math.max(0, history.length - HISTORY_LIMIT);
  const historyTruncated = (contract.historyTruncated ?? 0) + overflow;
  return {
    ...contract,
    history: overflow ? history.slice(overflow) : history,
    historyTruncated: historyTruncated || undefined,
  };
}

function adoptionFile(
  path: string,
  contentType: "application/json" | "text/yaml" | "text/markdown",
  content: string,
) {
  return { path, contentType, content, sha256: createHash("sha256").update(content).digest("hex") };
}

function continuousAssuranceWorkflow(projectId: string, assuranceCaseId: string): string {
  return [
    "name: AgentCert continuous assurance",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "  schedule:",
    "    - cron: \"17 6 * * *\"",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  assurance:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 20",
    "    env:",
    "      AGENTCERT_BASE_URL: https://agentcert.app",
    `      AGENTCERT_PROJECT_ID: ${projectId}`,
    "      AGENTCERT_API_KEY: ${{ secrets.AGENTCERT_API_KEY }}",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: Kakarottoooo/agentcert/actions/tripwire@v0",
    "        with:",
    "          config: tripwire.yml",
    "          pull-request-config: tripwire.yml",
    "          release-config: tripwire.yml",
    "          nightly-config: tripwire.yml",
    "          push-hosted: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    `          assurance-case: ${assuranceCaseId}`,
    "          assurance-scope: agentcert.assurance-scope.json",
    "          assurance-trigger: auto",
    "          require-current: auto",
    "          continuous-health-out: .agentcert/latest/continuous-assurance-health.json",
    "      - name: Assert and publish redacted Hosted health",
    "        if: ${{ always() && github.event_name != 'pull_request' }}",
    "        shell: bash",
    "        run: |",
    "          node - <<'NODE'",
    "          const fs = require('node:fs');",
    "          const source = '.agentcert/latest/continuous-assurance-health.json';",
    "          if (!fs.existsSync(source)) throw new Error('Generated kit did not produce Hosted continuous assurance health.');",
    "          const health = JSON.parse(fs.readFileSync(source, 'utf8'));",
    "          const publicHealth = {",
    "            schemaVersion: 'agentcert.generated_kit_health.v0.1',",
    "            healthy: health.healthy === true,",
    "            status: health.status,",
    "            checkedAt: health.checkedAt,",
    "            runStatus: health.run?.status,",
    "            trigger: health.assurance?.trigger,",
    "            authoritative: health.assurance?.authoritative === true,",
    "            timeToFirstCurrentMs: health.assurance?.timeToFirstCurrentMs,",
    "            evidence: { status: health.evidence?.status, declared: health.evidence?.declared, matched: health.evidence?.matched },",
    "            diagnostics: Array.isArray(health.diagnostics) ? health.diagnostics.map(({ code }) => ({ code })) : [],",
    "          };",
    "          fs.mkdirSync('.agentcert/canary', { recursive: true });",
    "          fs.writeFileSync('.agentcert/canary/generated-kit-health.json', `${JSON.stringify(publicHealth, null, 2)}\\n`);",
    "          if (!publicHealth.healthy || publicHealth.status !== 'CURRENT' || !publicHealth.authoritative || publicHealth.evidence.status !== 'complete') {",
    "            throw new Error(`Generated kit Hosted E2E failed: status=${publicHealth.status}, evidence=${publicHealth.evidence.status}, diagnostics=${publicHealth.diagnostics.map((item) => item.code).join(',')}`);",
    "          }",
    "          NODE",
    "      - name: Upload generated-kit public health",
    "        if: ${{ always() && github.event_name != 'pull_request' }}",
    "        uses: actions/upload-artifact@v7",
    "        with:",
    "          name: agentcert-generated-kit-health",
    "          path: .agentcert/canary/generated-kit-health.json",
    "          if-no-files-found: error",
    "          retention-days: 30",
    "",
  ].join("\n");
}

function continuousAssuranceReadme(assuranceCaseId: string, fingerprint: string): string {
  return [
    "# AgentCert Continuous Assurance",
    "",
    `Assurance case: \`${assuranceCaseId}\``,
    `Scope fingerprint: \`${fingerprint}\``,
    "",
    "1. Add the generated files at their exact repository paths.",
    "2. Add `AGENTCERT_API_KEY` as a GitHub Actions repository secret.",
    "3. Keep `tripwire.yml` deterministic and committed. The generated workflow selects PR, release, and nightly modes explicitly; replace each layered config path when the suites diverge.",
    "   Fork pull requests run the local prospective gate without receiving or using the Hosted API key.",
    "4. Open a pull request to verify prospective drift, merge to run the authoritative release check, and keep the nightly schedule enabled.",
    "5. Release and nightly jobs fail unless Hosted AgentCert confirms the run is CURRENT with complete evidence. The health artifact records time from kit activation to the first authoritative CURRENT run.",
    "6. `agentcert-generated-kit-health` is a redacted CI artifact. It contains no API key, project ID, case ID, run ID, or scope fingerprint and is safe to expose as canary health.",
    "",
    "A changed agent, model, prompt, tool manifest, policy, or scenario suite requires a new signed revalidation case.",
    "",
  ].join("\n");
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
