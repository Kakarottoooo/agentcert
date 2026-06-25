export interface MonitorSnapshot {
  schemaVersion: "1";
  kind: "agentcert.monitor_snapshot";
  generatedAt: string;
  subject: string;
  summary: CorpusSummary;
  lifecycle: LifecycleGate[];
  recentRuns: MonitorRun[];
  failurePatterns: FailurePattern[];
  links: {
    detailUrl?: string;
  };
}

export interface CorpusSummary {
  totalRecords: number;
  passedRecords: number;
  failedRecords: number;
  passRate: number;
  byProduct: SummaryBucket[];
  byFault: SummaryBucket[];
  topFailurePatterns: FailurePattern[];
}

export interface SummaryBucket {
  key: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

export interface LifecycleGate {
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

export interface FailurePattern {
  key: string;
  count: number;
  severity: string;
  message: string;
}

export interface RunDetail {
  record: CorpusRecord;
  failurePatterns: Array<{ key: string; severity: string; message: string; scenarioName?: string; faultName?: string }>;
  assertions: AssertionResult[];
  timeline: EvidenceTimelineItem[];
  artifacts: EvidenceArtifact[];
  traceSummary?: {
    stepCount: number;
    firstStepText?: string;
    lastStepText?: string;
    firstDivergenceStep?: number;
  };
  finalUrl?: string;
  diagnostics: string[];
  warnings: string[];
}

export interface CorpusRecord extends MonitorRun {
  schemaVersion: "1";
  kind: "product_run" | "scenario_run";
  ingestedAt: string;
  runId: string;
  stepCount?: number;
  highOrCriticalEvidenceCount: number;
  failurePatterns: Array<{ key: string; severity: string; message: string; scenarioName?: string; faultName?: string }>;
  sourcePath: string;
  metadata?: Record<string, unknown>;
}

export interface AssertionResult {
  type: string;
  pass: boolean;
  message: string;
  expected?: unknown;
  observed?: unknown;
}

export interface EvidenceTimelineItem {
  kind: "failure" | "agent-action" | "page-state" | "network" | "console";
  title: string;
  timestamp?: string;
  message: string;
  stepIndex?: number;
  artifactPath?: string;
}

export interface EvidenceArtifact {
  label: string;
  kind: "screenshot" | "dom" | "trace" | "json" | "events" | "report" | "other";
  path: string;
  url: string;
  sizeBytes?: number;
}
