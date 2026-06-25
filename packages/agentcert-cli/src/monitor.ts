import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentCertCorpusRecord, CorpusSummary } from "./corpus.js";
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
  lifecycle: MonitorLifecycleGate[];
  recentRuns: MonitorRun[];
  failurePatterns: Array<{ key: string; count: number; severity: string; message: string }>;
  links: {
    detailUrl?: string;
  };
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
  scenarioName?: string;
  faultName?: string;
  passed: boolean;
  score: number;
  timestamp: string;
  durationMs?: number;
  evidenceCount: number;
  primaryFailure?: string;
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
        scenarioName: record.scenarioName,
        faultName: record.faultName,
        passed: record.passed,
        score: record.score,
        timestamp: record.timestamp,
        durationMs: record.durationMs,
        evidenceCount: record.evidenceCount,
        primaryFailure: record.failurePatterns[0]?.message,
        artifacts: record.artifacts,
      })),
    failurePatterns: summary.topFailurePatterns,
    links: {
      detailUrl: options.detailUrl,
    },
  };
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
