import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentCertEvidence, AgentCertResult } from "./types.js";

export type CorpusRecordKind = "product_run" | "scenario_run";

export interface FailurePattern {
  key: string;
  severity: AgentCertEvidence["severity"];
  message: string;
  scenarioName?: string;
  faultName?: string;
}

export interface AgentCertCorpusRecord {
  schemaVersion: "1";
  kind: CorpusRecordKind;
  id: string;
  ingestedAt: string;
  subject: string;
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
}

export interface CorpusSummary {
  totalRecords: number;
  passedRecords: number;
  failedRecords: number;
  passRate: number;
  byProduct: SummaryBucket[];
  byFault: SummaryBucket[];
  topFailurePatterns: Array<{ key: string; count: number; message: string; severity: AgentCertEvidence["severity"] }>;
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
      product: result.product,
      phase: result.phase,
      runId: result.runId,
      timestamp: result.timestamp,
      score: result.score,
      passed: result.passed,
      evidenceCount: result.evidence.length,
      highOrCriticalEvidenceCount: countHighOrCritical(result.evidence),
      failurePatterns: failurePatternsFromEvidence(result.evidence),
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
    topFailurePatterns: topFailurePatterns(records),
  };
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
    const failurePatterns = failedAssertions.map((assertion) => ({
      key: `tripwire:${faultName ?? "unknown"}:${stringValue(assertion.type) ?? "assertion"}`,
      severity: "high" as const,
      message: stringValue(assertion.message) ?? "Tripwire assertion failed.",
      scenarioName,
      faultName,
    }));

    return {
      schemaVersion: "1",
      kind: "scenario_run",
      id: stableRecordId([subject, result.product, runId, sourcePath]),
      ingestedAt,
      subject,
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
        scenarioName: stringValue(metadata.scenarioName),
        faultName: stringValue(metadata.faultName),
      };
    });
}

function topFailurePatterns(records: AgentCertCorpusRecord[]): CorpusSummary["topFailurePatterns"] {
  const counts = new Map<string, { count: number; message: string; severity: AgentCertEvidence["severity"] }>();
  for (const pattern of records.flatMap((record) => record.failurePatterns)) {
    const current = counts.get(pattern.key);
    counts.set(pattern.key, {
      count: (current?.count ?? 0) + 1,
      message: current?.message ?? pattern.message,
      severity: current?.severity ?? pattern.severity,
    });
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 10);
}

function bucket(records: AgentCertCorpusRecord[], keyFor: (record: AgentCertCorpusRecord) => string): SummaryBucket[] {
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

function renderBuckets(buckets: SummaryBucket[]): string[] {
  if (buckets.length === 0) {
    return ["- none"];
  }
  return buckets.map(
    (bucket) =>
      `- ${bucket.key}: ${bucket.passed}/${bucket.total} passed (${(bucket.passRate * 100).toFixed(1)}%), ${bucket.failed} failed`,
  );
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
