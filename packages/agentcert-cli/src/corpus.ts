import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentCertEvidence, AgentCertResult } from "./types.js";

export type CorpusRecordKind = "product_run" | "scenario_run";

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

export type FailureReviewStatus = "unreviewed" | "confirmed" | "corrected";

export interface FailureReviewEvidenceContext {
  firstDivergenceSnippet?: string;
  screenshotPath?: string;
  screenshotUrl?: string;
  tracePath?: string;
  stepIndex?: number;
}

export interface FailureTaxonomyRationale {
  primaryReason: string;
  supportingSignals?: string[];
  contradictingSignals?: string[];
  classifierLimitation?: string;
}

export interface FailurePattern {
  key: string;
  severity: AgentCertEvidence["severity"];
  message: string;
  type: FailureType;
  suggestedType?: FailureType;
  reviewStatus?: FailureReviewStatus;
  reviewId?: string;
  reviewedAt?: string;
  reviewer?: string;
  reviewNote?: string;
  reviewConfidence?: number;
  reviewEvidenceContext?: FailureReviewEvidenceContext;
  taxonomyRationale?: FailureTaxonomyRationale;
  scenarioName?: string;
  faultName?: string;
}

export interface AgentCertCorpusRecord {
  schemaVersion: "1";
  kind: CorpusRecordKind;
  id: string;
  ingestedAt: string;
  subject: string;
  agentName: string;
  agentVersion: string;
  product: AgentCertResult["product"];
  phase: AgentCertResult["phase"];
  runId: string;
  timestamp: string;
  score: number;
  passed: boolean;
  scenarioName?: string;
  faultName?: string;
  durationMs?: number;
  stepCount?: number;
  evidenceCount: number;
  highOrCriticalEvidenceCount: number;
  failurePatterns: FailurePattern[];
  artifacts: Record<string, string>;
  sourcePath: string;
  metadata?: Record<string, unknown>;
  governance?: import("./corpus-governance.js").CorpusGovernance;
}

export interface CorpusSummary {
  totalRecords: number;
  passedRecords: number;
  failedRecords: number;
  passRate: number;
  byProduct: SummaryBucket[];
  byFault: SummaryBucket[];
  byAgent: SummaryBucket[];
  byVersion: SummaryBucket[];
  byFailureType: SummaryBucket[];
  taxonomy: {
    totalFailurePatterns: number;
    reviewedFailurePatterns: number;
    unreviewedFailurePatterns: number;
    confirmedFailurePatterns: number;
    correctedFailurePatterns: number;
    reviewCoverage: number;
    autoLabelPrecision: number;
    correctionRate: number;
    meanReviewerConfidence?: number;
  };
  topFailurePatterns: Array<{
    key: string;
    count: number;
    message: string;
    severity: AgentCertEvidence["severity"];
    type: FailureType;
  }>;
}

export interface ReviewedFailureDatasetRow {
  schemaVersion: "1";
  kind: "agentcert.reviewed_failure";
  id: string;
  recordId: string;
  subject: string;
  agentName: string;
  agentVersion: string;
  product: AgentCertResult["product"];
  phase: AgentCertResult["phase"];
  runId: string;
  timestamp: string;
  scenarioName?: string;
  faultName?: string;
  patternKey: string;
  severity: AgentCertEvidence["severity"];
  message: string;
  suggestedType: FailureType;
  reviewedType: FailureType;
  reviewStatus: Extract<FailureReviewStatus, "confirmed" | "corrected">;
  reviewer?: string;
  reviewedAt?: string;
  reviewConfidence?: number;
  firstDivergenceSnippet?: string;
  screenshotPath?: string;
  screenshotUrl?: string;
  tracePath?: string;
  stepIndex?: number;
  taxonomyRationale?: FailureTaxonomyRationale;
  sourcePath: string;
}

export interface FailureClassifierEvaluation {
  schemaVersion: "1";
  kind: "agentcert.failure_classifier_evaluation";
  reviewedRows: number;
  correctRows: number;
  incorrectRows: number;
  precision: number;
  coverage: number;
  byType: Array<{
    type: FailureType;
    reviewedRows: number;
    correctRows: number;
    precision: number;
  }>;
  confusion: Array<{
    suggestedType: FailureType;
    reviewedType: FailureType;
    count: number;
  }>;
}

export interface SummaryBucket {
  key: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

export function recordsFromAgentCertResult(
  result: AgentCertResult,
  sourcePath: string,
  subject: string,
  rawInput?: unknown,
  ingestedAt = new Date().toISOString(),
): AgentCertCorpusRecord[] {
  if (result.product === "tripwire-ci") {
    const tripwireRecords = recordsFromTripwireInput(result, sourcePath, subject, rawInput, ingestedAt);
    if (tripwireRecords.length > 0) {
      return tripwireRecords;
    }
  }

  return [
    {
      schemaVersion: "1",
      kind: "product_run",
      id: stableRecordId([subject, result.product, result.runId, sourcePath]),
      ingestedAt,
      subject,
      agentName: subject,
      agentVersion: "unversioned",
      product: result.product,
      phase: result.phase,
      runId: result.runId,
      timestamp: result.timestamp,
      score: result.score,
      passed: result.passed,
      evidenceCount: result.evidence.length,
      highOrCriticalEvidenceCount: countHighOrCritical(result.evidence),
      failurePatterns: result.passed ? [] : failurePatternsFromEvidence(result.evidence),
      artifacts: result.artifacts,
      sourcePath,
      metadata: result.summary ? { summary: result.summary } : undefined,
    },
  ];
}

export function summarizeCorpus(records: AgentCertCorpusRecord[]): CorpusSummary {
  const totalRecords = records.length;
  const passedRecords = records.filter((record) => record.passed).length;
  const failedRecords = totalRecords - passedRecords;
  return {
    totalRecords,
    passedRecords,
    failedRecords,
    passRate: ratio(passedRecords, totalRecords),
    byProduct: bucket(records, (record) => record.product),
    byFault: bucket(
      records.filter((record) => record.faultName),
      (record) => record.faultName ?? "unknown",
    ),
    byAgent: bucket(records, (record) => record.agentName),
    byVersion: bucket(records, (record) => record.agentVersion),
    byFailureType: bucket(
      records.flatMap((record) =>
        record.failurePatterns.map((pattern) => ({
          ...record,
          failureTypeForBucket: pattern.type,
          passed: false,
        })),
      ),
      (record) => record.failureTypeForBucket ?? "unknown_failure",
    ),
    taxonomy: taxonomySummary(records),
    topFailurePatterns: topFailurePatterns(records),
  };
}

export function reviewedFailureDataset(records: AgentCertCorpusRecord[]): ReviewedFailureDatasetRow[] {
  return records.flatMap((record) =>
    record.failurePatterns
      .filter(isReviewedPattern)
      .map((pattern) => ({
        schemaVersion: "1" as const,
        kind: "agentcert.reviewed_failure" as const,
        id: stableRecordId([record.id, pattern.key, pattern.reviewId ?? pattern.reviewedAt ?? pattern.type]),
        recordId: record.id,
        subject: record.subject,
        agentName: record.agentName,
        agentVersion: record.agentVersion,
        product: record.product,
        phase: record.phase,
        runId: record.runId,
        timestamp: record.timestamp,
        scenarioName: record.scenarioName,
        faultName: record.faultName,
        patternKey: pattern.key,
        severity: pattern.severity,
        message: pattern.message,
        suggestedType: pattern.suggestedType ?? pattern.type,
        reviewedType: pattern.type,
        reviewStatus: pattern.reviewStatus,
        reviewer: pattern.reviewer,
        reviewedAt: pattern.reviewedAt,
        reviewConfidence: pattern.reviewConfidence,
        firstDivergenceSnippet: pattern.reviewEvidenceContext?.firstDivergenceSnippet,
        screenshotPath: pattern.reviewEvidenceContext?.screenshotPath,
        screenshotUrl: pattern.reviewEvidenceContext?.screenshotUrl,
        tracePath: pattern.reviewEvidenceContext?.tracePath,
        stepIndex: pattern.reviewEvidenceContext?.stepIndex,
        taxonomyRationale: pattern.taxonomyRationale,
        sourcePath: record.sourcePath,
      })),
  );
}

export function evaluateFailureClassifier(records: AgentCertCorpusRecord[]): FailureClassifierEvaluation {
  const rows = reviewedFailureDataset(records);
  const correctRows = rows.filter((row) => row.suggestedType === row.reviewedType).length;
  const byTypeBuckets = new Map<FailureType, { reviewedRows: number; correctRows: number }>();
  const confusionBuckets = new Map<string, { suggestedType: FailureType; reviewedType: FailureType; count: number }>();

  for (const row of rows) {
    const byType = byTypeBuckets.get(row.reviewedType) ?? { reviewedRows: 0, correctRows: 0 };
    byType.reviewedRows += 1;
    if (row.suggestedType === row.reviewedType) byType.correctRows += 1;
    byTypeBuckets.set(row.reviewedType, byType);

    const confusionKey = `${row.suggestedType}->${row.reviewedType}`;
    const confusion = confusionBuckets.get(confusionKey) ?? {
      suggestedType: row.suggestedType,
      reviewedType: row.reviewedType,
      count: 0,
    };
    confusion.count += 1;
    confusionBuckets.set(confusionKey, confusion);
  }

  const totalFailurePatterns = records.reduce((sum, record) => sum + record.failurePatterns.length, 0);
  return {
    schemaVersion: "1",
    kind: "agentcert.failure_classifier_evaluation",
    reviewedRows: rows.length,
    correctRows,
    incorrectRows: rows.length - correctRows,
    precision: ratio(correctRows, rows.length),
    coverage: ratio(rows.length, totalFailurePatterns),
    byType: [...byTypeBuckets.entries()]
      .map(([type, bucket]) => ({
        type,
        reviewedRows: bucket.reviewedRows,
        correctRows: bucket.correctRows,
        precision: ratio(bucket.correctRows, bucket.reviewedRows),
      }))
      .sort((left, right) => left.type.localeCompare(right.type)),
    confusion: [...confusionBuckets.values()].sort(
      (left, right) => right.count - left.count || left.suggestedType.localeCompare(right.suggestedType),
    ),
  };
}

export async function writeReviewedFailureDataset(path: string, records: AgentCertCorpusRecord[]): Promise<ReviewedFailureDatasetRow[]> {
  const rows = reviewedFailureDataset(records);
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(outPath, `${payload}${payload.length > 0 ? "\n" : ""}`);
  return rows;
}

export async function appendCorpusRecords(path: string, records: AgentCertCorpusRecord[], replace = false): Promise<void> {
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  const prefix = replace ? "" : await existingCorpus(outPath);
  const separator = prefix.length > 0 && payload.length > 0 ? "\n" : "";
  await writeFile(outPath, `${prefix}${separator}${payload}${payload.length > 0 ? "\n" : ""}`);
}

export async function readCorpus(path: string): Promise<AgentCertCorpusRecord[]> {
  const raw = await readFile(resolve(path), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentCertCorpusRecord);
}

export function renderCorpusSummary(summary: CorpusSummary): string {
  const lines = [
    "# AgentCert Corpus Summary",
    "",
    `Total records: ${summary.totalRecords}`,
    `Passed: ${summary.passedRecords}`,
    `Failed: ${summary.failedRecords}`,
    `Pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
    `Taxonomy review coverage: ${(summary.taxonomy.reviewCoverage * 100).toFixed(1)}%`,
    `Reviewed-label precision: ${(summary.taxonomy.autoLabelPrecision * 100).toFixed(1)}%`,
    `Correction rate: ${(summary.taxonomy.correctionRate * 100).toFixed(1)}%`,
    "",
    "## By Product",
    ...renderBuckets(summary.byProduct),
    "",
    "## By Fault",
    ...renderBuckets(summary.byFault),
    "",
    "## Top Failure Patterns",
    ...summary.topFailurePatterns.map((pattern) => `- ${pattern.key}: ${pattern.count} (${pattern.severity}) - ${pattern.message}`),
  ];
  return `${lines.join("\n")}\n`;
}

function recordsFromTripwireInput(
  result: AgentCertResult,
  sourcePath: string,
  subject: string,
  rawInput: unknown,
  ingestedAt: string,
): AgentCertCorpusRecord[] {
  const input = asRecord(rawInput);
  const runs = Array.isArray(input.runs) ? input.runs : [];
  return runs.map((run, index) => {
    const record = asRecord(run);
    const assertions = Array.isArray(record.assertions) ? record.assertions.map(asRecord) : [];
    const failedAssertions = assertions.filter((assertion) => assertion.pass === false);
    const scenarioName = stringValue(record.scenarioName);
    const faultName = stringValue(record.faultName);
    const runId = stringValue(record.runId) ?? `${result.runId}_${index + 1}`;
    const passed = record.status === "passed";
    const agent = asRecord(record.agent);
    const agentEnv = asRecord(agent.env);
    const agentName = agentNameFromTripwireRun(agent, subject);
    const agentVersion = stringValue(agentEnv.AGENTCERT_AGENT_VERSION) ?? stringValue(agentEnv.AGENT_VERSION) ?? "unversioned";
    const failurePatterns = failedAssertions.map((assertion) => {
      const assertionType = stringValue(assertion.type) ?? "assertion";
      const message = stringValue(assertion.message) ?? "Tripwire assertion failed.";
      const failureType = classifyTripwireFailure({
        faultName,
        assertionType,
        message,
        run: record,
      });
      return {
        key: `tripwire:${failureType}:${faultName ?? "unknown"}:${assertionType}`,
        severity: "high" as const,
        message,
        type: failureType,
        suggestedType: failureType,
        reviewStatus: "unreviewed" as const,
        scenarioName,
        faultName,
      };
    });
    if (!passed && failurePatterns.length === 0) {
      const failureType = classifyTripwireFailure({
        faultName,
        assertionType: "run_status",
        message: "Tripwire run failed without a failed assertion.",
        run: record,
      });
      failurePatterns.push({
        key: `tripwire:${failureType}:${faultName ?? "unknown"}:run_status`,
        severity: "high",
        message: "Tripwire run failed without a failed assertion.",
        type: failureType,
        suggestedType: failureType,
        reviewStatus: "unreviewed",
        scenarioName,
        faultName,
      });
    }

    return {
      schemaVersion: "1",
      kind: "scenario_run",
      id: stableRecordId([subject, result.product, runId, sourcePath]),
      ingestedAt,
      subject,
      agentName,
      agentVersion,
      product: result.product,
      phase: result.phase,
      runId,
      timestamp: stringValue(record.startedAt) ?? result.timestamp,
      score: passed ? 100 : 0,
      passed,
      scenarioName,
      faultName,
      durationMs: numberValue(record.durationMs),
      stepCount: numberValue(record.stepCount),
      evidenceCount: failedAssertions.length,
      highOrCriticalEvidenceCount: failedAssertions.length,
      failurePatterns,
      artifacts: {
        result: sourcePath,
        trace: stringValue(record.tracePath) ?? "",
        artifactDir: stringValue(record.artifactDir) ?? "",
      },
      sourcePath,
      metadata: {
        finalUrl: stringValue(record.finalUrl),
        diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
        warnings: Array.isArray(record.warnings) ? record.warnings : [],
        failureTypes: [...new Set(failurePatterns.map((pattern) => pattern.type))],
      },
    };
  });
}

function failurePatternsFromEvidence(evidence: AgentCertEvidence[]): FailurePattern[] {
  return evidence
    .filter((item) => item.severity === "critical" || item.severity === "high" || item.severity === "medium")
    .map((item) => {
      const metadata = asRecord(item.metadata);
      return {
        key: `${item.source ?? "agentcert"}:${stringValue(metadata.faultName) ?? item.kind}`,
        severity: item.severity,
        message: item.message,
        type: classifyEvidenceFailure(item),
        suggestedType: classifyEvidenceFailure(item),
        reviewStatus: "unreviewed",
        scenarioName: stringValue(metadata.scenarioName),
        faultName: stringValue(metadata.faultName),
      };
    });
}

function taxonomySummary(records: AgentCertCorpusRecord[]): CorpusSummary["taxonomy"] {
  const patterns = records.flatMap((record) => record.failurePatterns);
  const confirmedFailurePatterns = patterns.filter((pattern) => pattern.reviewStatus === "confirmed").length;
  const correctedFailurePatterns = patterns.filter((pattern) => pattern.reviewStatus === "corrected").length;
  const reviewedFailurePatterns = confirmedFailurePatterns + correctedFailurePatterns;
  const reviewedPatterns = patterns.filter(isReviewedPattern);
  const confidenceValues = reviewedPatterns
    .map((pattern) => pattern.reviewConfidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    totalFailurePatterns: patterns.length,
    reviewedFailurePatterns,
    unreviewedFailurePatterns: patterns.length - reviewedFailurePatterns,
    confirmedFailurePatterns,
    correctedFailurePatterns,
    reviewCoverage: ratio(reviewedFailurePatterns, patterns.length),
    autoLabelPrecision: ratio(confirmedFailurePatterns, reviewedFailurePatterns),
    correctionRate: ratio(correctedFailurePatterns, reviewedFailurePatterns),
    meanReviewerConfidence: confidenceValues.length === 0 ? undefined : confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length,
  };
}

function topFailurePatterns(records: AgentCertCorpusRecord[]): CorpusSummary["topFailurePatterns"] {
  const counts = new Map<string, { count: number; message: string; severity: AgentCertEvidence["severity"]; type: FailureType }>();
  for (const pattern of records.flatMap((record) => record.failurePatterns)) {
    const current = counts.get(pattern.key);
    counts.set(pattern.key, {
      count: (current?.count ?? 0) + 1,
      message: current?.message ?? pattern.message,
      severity: current?.severity ?? pattern.severity,
      type: current?.type ?? pattern.type,
    });
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 10);
}

function bucket<T extends AgentCertCorpusRecord>(records: T[], keyFor: (record: T) => string): SummaryBucket[] {
  const buckets = new Map<string, { total: number; passed: number }>();
  for (const record of records) {
    const key = keyFor(record);
    const current = buckets.get(key) ?? { total: 0, passed: 0 };
    current.total += 1;
    if (record.passed) current.passed += 1;
    buckets.set(key, current);
  }
  return [...buckets.entries()]
    .map(([key, value]) => ({
      key,
      total: value.total,
      passed: value.passed,
      failed: value.total - value.passed,
      passRate: ratio(value.passed, value.total),
    }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

function classifyTripwireFailure(input: {
  faultName?: string;
  assertionType: string;
  message: string;
  run: Record<string, unknown>;
}): FailureType {
  const fault = input.faultName ?? "";
  const assertion = input.assertionType;
  const message = input.message.toLowerCase();
  const diagnostics = stringArray(input.run.diagnostics).join(" ").toLowerCase();
  const warnings = stringArray(input.run.warnings).join(" ").toLowerCase();
  const agentResult = asRecord(input.run.agentResult);

  if (agentResult.timedOut === true || assertion === "max_steps" || message.includes("timed out")) return "timeout";
  if (fault.includes("prompt-injection") || assertion === "no_sensitive_text_in_output" || message.includes("ignore previous instructions")) {
    return "prompt_injection";
  }
  if (fault.includes("misleading-button") || message.includes("wrong button") || message.includes("cancel")) return "wrong_click";
  if (fault.includes("button-text-drift") || fault.includes("layout-shift") || fault.includes("modal-overlay") || fault.includes("disabled-submit")) {
    return "ui_drift";
  }
  if (fault.includes("slow-network") || fault.includes("http-failure") || message.includes("network") || message.includes("503")) {
    return "network_failure";
  }
  if (assertion === "no_console_error" || message.includes("console")) return "console_error";
  if (diagnostics.includes("did not appear to connect") || warnings.includes("did not appear to connect")) return "agent_connection";
  if (agentResult.exitCode === 0 && (assertion === "url_contains" || assertion === "text_exists")) return "silent_partial_success";
  return "assertion_failure";
}

function isReviewedPattern(pattern: FailurePattern): pattern is FailurePattern & {
  reviewStatus: Extract<FailureReviewStatus, "confirmed" | "corrected">;
} {
  return pattern.reviewStatus === "confirmed" || pattern.reviewStatus === "corrected";
}

function classifyEvidenceFailure(evidence: AgentCertEvidence): FailureType {
  const kind = evidence.kind.toLowerCase();
  const message = evidence.message.toLowerCase();
  if (kind.includes("verification") || message.includes("did not match expected")) return "verification_gap";
  if (kind.includes("approval") || kind.includes("policy") || message.includes("approval")) return "policy_or_approval";
  if (kind.includes("timeout") || message.includes("timeout")) return "timeout";
  if (kind.includes("prompt") || message.includes("prompt injection")) return "prompt_injection";
  return "unknown_failure";
}

function agentNameFromTripwireRun(agent: Record<string, unknown>, fallback: string): string {
  const args = Array.isArray(agent.args) ? agent.args.filter((item): item is string => typeof item === "string") : [];
  const command = stringValue(agent.command);
  const candidate = [...args].reverse().find((arg) => /agent|browser-use|stagehand|playwright/i.test(arg));
  if (candidate) {
    return candidate
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(mjs|js|py|ts)$/i, "")
      .replace(/[_-]+/g, " ") ?? fallback;
  }
  return command ?? fallback;
}

function renderBuckets(buckets: SummaryBucket[]): string[] {
  if (buckets.length === 0) {
    return ["- none"];
  }
  return buckets.map(
    (bucket) =>
      `- ${bucket.key}: ${bucket.passed}/${bucket.total} passed (${(bucket.passRate * 100).toFixed(1)}%), ${bucket.failed} failed`,
  );
}

function stringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
}

async function existingCorpus(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trimEnd();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function countHighOrCritical(evidence: AgentCertEvidence[]): number {
  return evidence.filter((item) => item.severity === "critical" || item.severity === "high").length;
}

function stableRecordId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}
