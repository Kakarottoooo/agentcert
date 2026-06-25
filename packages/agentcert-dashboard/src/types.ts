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
