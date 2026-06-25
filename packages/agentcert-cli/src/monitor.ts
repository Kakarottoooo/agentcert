import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentCertCorpusRecord, CorpusSummary, FailurePattern } from "./corpus.js";
import { summarizeCorpus } from "./corpus.js";

export interface MonitorOptions {
  subject: string;
  detailUrl?: string;
}

export interface MonitorSnapshot {
  schemaVersion: "1";
  kind: "agentcert.monitor_snapshot";
  generatedAt: string;
  subject: string;
  summary: CorpusSummary;
  filters: MonitorFilters;
  lifecycle: MonitorLifecycleGate[];
  recentRuns: MonitorRun[];
  failurePatterns: Array<{ key: string; count: number; severity: string; message: string; type: string }>;
  links: {
    detailUrl?: string;
  };
}

export interface MonitorFilters {
  agents: string[];
  faults: string[];
  versions: string[];
  failureTypes: string[];
  products: string[];
  reviewStatuses: MonitorRun["taxonomyReviewStatus"][];
}

export interface MonitorLifecycleGate {
  id: "mcpbench" | "tripwire-ci" | "onegent-runtime";
  name: string;
  phase: "Before release" | "After release";
  description: string;
  recordCount: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  status: "passing" | "failing" | "waiting";
}

export interface MonitorRun {
  id: string;
  product: string;
  phase: string;
  subject: string;
  agentName: string;
  agentVersion: string;
  scenarioName?: string;
  faultName?: string;
  failureTypes: string[];
  passed: boolean;
  score: number;
  timestamp: string;
  durationMs?: number;
  evidenceCount: number;
  primaryFailure?: string;
  failurePatterns: FailurePattern[];
  taxonomyReviewStatus: "none" | "needs_review" | "reviewed";
  reviewedFailureCount: number;
  unreviewedFailureCount: number;
  artifacts: Record<string, string>;
}

export function buildMonitorSnapshot(records: AgentCertCorpusRecord[], options: MonitorOptions): MonitorSnapshot {
  const summary = summarizeCorpus(records);
  return {
    schemaVersion: "1",
    kind: "agentcert.monitor_snapshot",
    generatedAt: new Date().toISOString(),
    subject: options.subject,
    summary,
    filters: buildFilters(records),
    lifecycle: [
      lifecycleGate(records, {
        id: "mcpbench",
        name: "MCPBench",
        phase: "Before release",
        description: "MCP servers, exposed tools, policy behavior, and runtime traces.",
      }),
      lifecycleGate(records, {
        id: "tripwire-ci",
        name: "Tripwire CI",
        phase: "Before release",
        description: "Browser and computer-use agents under adversarial UI and network faults.",
      }),
      lifecycleGate(records, {
        id: "onegent-runtime",
        name: "Onegent Runtime",
        phase: "After release",
        description: "High-risk live actions requiring approval, verification, and audit.",
      }),
    ],
    recentRuns: [...records]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 50)
      .map((record) => ({
        id: record.id,
        product: record.product,
        phase: record.phase,
        subject: record.subject,
        agentName: record.agentName,
        agentVersion: record.agentVersion,
        scenarioName: record.scenarioName,
        faultName: record.faultName,
        failureTypes: [...new Set(record.failurePatterns.map((pattern) => pattern.type))],
        passed: record.passed,
        score: record.score,
        timestamp: record.timestamp,
        durationMs: record.durationMs,
        evidenceCount: record.evidenceCount,
        primaryFailure: record.failurePatterns[0]?.message,
        failurePatterns: record.failurePatterns,
        taxonomyReviewStatus: taxonomyReviewStatus(record.failurePatterns),
        reviewedFailureCount: record.failurePatterns.filter((pattern) => pattern.reviewStatus === "confirmed" || pattern.reviewStatus === "corrected").length,
        unreviewedFailureCount: record.failurePatterns.filter((pattern) => (pattern.reviewStatus ?? "unreviewed") === "unreviewed").length,
        artifacts: record.artifacts,
      })),
    failurePatterns: summary.topFailurePatterns,
    links: {
      detailUrl: options.detailUrl,
    },
  };
}

function buildFilters(records: AgentCertCorpusRecord[]): MonitorFilters {
  return {
    agents: unique(records.map((record) => record.agentName)),
    faults: unique(records.map((record) => record.faultName).filter((value): value is string => Boolean(value))),
    versions: unique(records.map((record) => record.agentVersion)),
    failureTypes: unique(records.flatMap((record) => record.failurePatterns.map((pattern) => pattern.type))),
    products: unique(records.map((record) => record.product)),
    reviewStatuses: unique(records.map((record) => taxonomyReviewStatus(record.failurePatterns))),
  };
}

function taxonomyReviewStatus(patterns: FailurePattern[]): MonitorRun["taxonomyReviewStatus"] {
  if (patterns.length === 0) return "none";
  return patterns.every((pattern) => pattern.reviewStatus === "confirmed" || pattern.reviewStatus === "corrected") ? "reviewed" : "needs_review";
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function writeMonitorSnapshot(path: string, snapshot: MonitorSnapshot): Promise<void> {
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function lifecycleGate(
  records: AgentCertCorpusRecord[],
  gate: Omit<MonitorLifecycleGate, "recordCount" | "passedCount" | "failedCount" | "passRate" | "status">,
): MonitorLifecycleGate {
  const gateRecords = records.filter((record) => record.product === gate.id);
  const passedCount = gateRecords.filter((record) => record.passed).length;
  const failedCount = gateRecords.length - passedCount;
  const passRate = gateRecords.length === 0 ? 0 : passedCount / gateRecords.length;
  return {
    ...gate,
    recordCount: gateRecords.length,
    passedCount,
    failedCount,
    passRate,
    status: gateRecords.length === 0 ? "waiting" : passRate >= 0.8 ? "passing" : "failing",
  };
}
