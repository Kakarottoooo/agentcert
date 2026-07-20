import { randomUUID } from "node:crypto";
import { classifySemanticEvent, type SemanticClassification } from "./semantics.js";
import type { EventRecord, RunRecord } from "./types.js";

export const SEMANTIC_GOLDEN_DATASET_VERSION = "agentcert.semantic_golden_dataset.v0.1" as const;
export const SEMANTIC_ADAPTER_MATRIX_VERSION = "agentcert.semantic_adapter_matrix.v0.1" as const;

export interface SemanticGoldenCase {
  id: string;
  observedName: string;
  eventType: string;
  payload?: Record<string, unknown>;
  expectedCapabilityId?: string;
  rationale: string;
}

export interface SemanticGoldenAdapter {
  id: string;
  category: "browser" | "coding" | "data" | "messaging" | "finance";
  project: string;
  repository: string;
  sourceRef: string;
  sourceUrl: string;
  framework: string;
  calibrationMode: "recorded_run_and_source_contract" | "source_pinned_contract";
  cases: SemanticGoldenCase[];
}

export interface SemanticGoldenDataset {
  schemaVersion: typeof SEMANTIC_GOLDEN_DATASET_VERSION;
  datasetVersion: string;
  createdAt: string;
  adapters: SemanticGoldenAdapter[];
  controls: SemanticGoldenCase[];
}

export interface SemanticCalibrationResult {
  adapterId: string;
  caseId: string;
  expectedCapabilityId?: string;
  actualCapabilityId?: string;
  resolution: SemanticClassification["resolution"];
  outcome: "exact" | "false_unknown" | "misclassified" | "false_known";
}

export interface SemanticCalibrationMetrics {
  total: number;
  expectedKnown: number;
  expectedUnknown: number;
  exact: number;
  falseUnknown: number;
  misclassified: number;
  falseKnown: number;
  exactMatchRate: number;
  falseUnknownRate: number;
}

export interface SemanticAdapterMatrix {
  schemaVersion: typeof SEMANTIC_ADAPTER_MATRIX_VERSION;
  generatedAt: string;
  dataset: { schemaVersion: string; version: string; createdAt: string };
  status: "passed" | "failed";
  metrics: SemanticCalibrationMetrics;
  adapters: Array<SemanticGoldenAdapter & { status: "passed" | "failed"; metrics: SemanticCalibrationMetrics }>;
  controls: { status: "passed" | "failed"; metrics: SemanticCalibrationMetrics };
  results: SemanticCalibrationResult[];
  claims: string[];
  limitations: string[];
}

export function parseSemanticGoldenDataset(input: unknown): SemanticGoldenDataset {
  const value = object(input, "dataset");
  if (value.schemaVersion !== SEMANTIC_GOLDEN_DATASET_VERSION) throw new Error(`schemaVersion must be ${SEMANTIC_GOLDEN_DATASET_VERSION}.`);
  if (!Array.isArray(value.adapters) || value.adapters.length !== 5) throw new Error("adapters must contain exactly five capability categories.");
  const adapters = value.adapters.map((item, index) => parseAdapter(item, `adapters[${index}]`));
  const categories = new Set(adapters.map((item) => item.category));
  if (categories.size !== 5) throw new Error("adapters must cover browser, coding, data, messaging, and finance exactly once.");
  if (!Array.isArray(value.controls) || value.controls.length === 0) throw new Error("controls must contain at least one expected-unknown case.");
  const controls = value.controls.map((item, index) => parseCase(item, `controls[${index}]`, false));
  return {
    schemaVersion: SEMANTIC_GOLDEN_DATASET_VERSION,
    datasetVersion: text(value.datasetVersion, "datasetVersion"),
    createdAt: timestamp(value.createdAt, "createdAt"),
    adapters,
    controls,
  };
}

export function evaluateSemanticGoldenDataset(input: unknown, generatedAt = new Date().toISOString()): SemanticAdapterMatrix {
  const dataset = parseSemanticGoldenDataset(input);
  const adapterResults = dataset.adapters.flatMap((adapter) => adapter.cases.map((testCase) => evaluateCase(adapter.id, adapter.framework, testCase)));
  const controlResults = dataset.controls.map((testCase) => evaluateCase("negative-controls", "agentcert-golden-control", testCase));
  const results = [...adapterResults, ...controlResults];
  const adapters = dataset.adapters.map((adapter) => {
    const metrics = calculateMetrics(adapterResults.filter((result) => result.adapterId === adapter.id));
    return { ...adapter, status: metrics.exact === metrics.total ? "passed" as const : "failed" as const, metrics };
  });
  const metrics = calculateMetrics(results);
  const controls = calculateMetrics(controlResults);
  return {
    schemaVersion: SEMANTIC_ADAPTER_MATRIX_VERSION,
    generatedAt,
    dataset: { schemaVersion: dataset.schemaVersion, version: dataset.datasetVersion, createdAt: dataset.createdAt },
    status: metrics.exact === metrics.total ? "passed" : "failed",
    metrics,
    adapters,
    controls: { status: controls.exact === controls.total ? "passed" : "failed", metrics: controls },
    results,
    claims: [
      "Pinned public tool contracts map deterministically to the expected AgentCert capability IDs.",
      "Expected-known cases are measured for false-unknown and semantic misclassification separately.",
      "Expected-unknown controls detect broad aliases that would otherwise inflate apparent coverage.",
    ],
    limitations: [
      "Source-pinned contract calibration is not a full runtime compatibility test of every framework release.",
      "Only browser-use includes an existing checked-in real-agent run; the other rows validate public tool interfaces.",
      "A semantic match proves classification only, not authorization, enforcement, outcome verification, or business correctness.",
      "The optional LLM suggestion provider is excluded from this deterministic score.",
    ],
  };
}

function evaluateCase(adapterId: string, framework: string, testCase: SemanticGoldenCase): SemanticCalibrationResult {
  const now = "2026-01-01T00:00:00.000Z";
  const run: RunRecord = {
    id: randomUUID(), projectId: "00000000-0000-4000-8000-000000000001", externalId: testCase.id,
    kind: "custom", status: "passed", schemaVersion: "1", startedAt: now, metadata: { framework },
  };
  const event: EventRecord = {
    id: randomUUID(), projectId: run.projectId, runId: run.id, sequence: 0, type: testCase.eventType,
    actor: "golden-dataset", occurredAt: now, payload: { ...(testCase.payload ?? {}), toolName: testCase.observedName },
  };
  const classification = classifySemanticEvent({ event, run });
  const expected = testCase.expectedCapabilityId;
  const actual = classification.capabilityId;
  const outcome = expected === actual
    ? "exact"
    : expected && !actual
      ? "false_unknown"
      : expected
        ? "misclassified"
        : "false_known";
  return { adapterId, caseId: testCase.id, expectedCapabilityId: expected, actualCapabilityId: actual, resolution: classification.resolution, outcome };
}

function calculateMetrics(results: SemanticCalibrationResult[]): SemanticCalibrationMetrics {
  const expectedKnown = results.filter((item) => item.expectedCapabilityId).length;
  const exact = results.filter((item) => item.outcome === "exact").length;
  const falseUnknown = results.filter((item) => item.outcome === "false_unknown").length;
  return {
    total: results.length,
    expectedKnown,
    expectedUnknown: results.length - expectedKnown,
    exact,
    falseUnknown,
    misclassified: results.filter((item) => item.outcome === "misclassified").length,
    falseKnown: results.filter((item) => item.outcome === "false_known").length,
    exactMatchRate: percent(exact, results.length),
    falseUnknownRate: percent(falseUnknown, expectedKnown),
  };
}

function parseAdapter(input: unknown, path: string): SemanticGoldenAdapter {
  const value = object(input, path);
  if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error(`${path}.cases must be a non-empty array.`);
  return {
    id: text(value.id, `${path}.id`),
    category: oneOf(value.category, `${path}.category`, ["browser", "coding", "data", "messaging", "finance"] as const),
    project: text(value.project, `${path}.project`),
    repository: url(value.repository, `${path}.repository`),
    sourceRef: sha(value.sourceRef, `${path}.sourceRef`),
    sourceUrl: url(value.sourceUrl, `${path}.sourceUrl`),
    framework: text(value.framework, `${path}.framework`),
    calibrationMode: oneOf(value.calibrationMode, `${path}.calibrationMode`, ["recorded_run_and_source_contract", "source_pinned_contract"] as const),
    cases: value.cases.map((item, index) => parseCase(item, `${path}.cases[${index}]`, true)),
  };
}

function parseCase(input: unknown, path: string, expectedKnown: boolean): SemanticGoldenCase {
  const value = object(input, path);
  const expectedCapabilityId = optionalText(value.expectedCapabilityId);
  if (expectedKnown && !expectedCapabilityId) throw new Error(`${path}.expectedCapabilityId is required.`);
  if (!expectedKnown && expectedCapabilityId) throw new Error(`${path}.expectedCapabilityId must be omitted for an unknown control.`);
  return {
    id: text(value.id, `${path}.id`), observedName: text(value.observedName, `${path}.observedName`),
    eventType: text(value.eventType, `${path}.eventType`), payload: value.payload === undefined ? undefined : object(value.payload, `${path}.payload`),
    expectedCapabilityId, rationale: text(value.rationale, `${path}.rationale`),
  };
}

function percent(numerator: number, denominator: number): number { return denominator ? Math.round((numerator / denominator) * 10_000) / 100 : 0; }
function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`); return value as Record<string, unknown>; }
function text(value: unknown, path: string): string { if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw new Error(`${path} must be a non-empty string.`); return value.trim(); }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function url(value: unknown, path: string): string { const result = text(value, path); if (!/^https:\/\//.test(result)) throw new Error(`${path} must be an HTTPS URL.`); return result; }
function sha(value: unknown, path: string): string { const result = text(value, path); if (!/^[a-f0-9]{40}$/.test(result)) throw new Error(`${path} must be a 40-character git commit.`); return result; }
function timestamp(value: unknown, path: string): string { const result = text(value, path); if (Number.isNaN(Date.parse(result))) throw new Error(`${path} must be an ISO timestamp.`); return result; }
function oneOf<const T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] { if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(", ")}.`); return value as T[number]; }
