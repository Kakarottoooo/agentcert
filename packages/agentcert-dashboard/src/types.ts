export interface MonitorSnapshot {
  schemaVersion: "1";
  kind: "agentcert.monitor_snapshot";
  generatedAt: string;
  subject: string;
  summary: CorpusSummary;
  filters: MonitorFilters;
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
  byAgent: SummaryBucket[];
  byVersion: SummaryBucket[];
  byFailureType: SummaryBucket[];
  taxonomy: {
    totalFailurePatterns: number;
    reviewedFailurePatterns: number;
    unreviewedFailurePatterns: number;
    confirmedFailurePatterns: number;
    correctedFailurePatterns: number;
  };
  topFailurePatterns: FailurePattern[];
}

export interface MonitorFilters {
  agents: string[];
  faults: string[];
  versions: string[];
  failureTypes: string[];
  products: string[];
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

export interface FailurePattern {
  key: string;
  count?: number;
  severity: string;
  message: string;
  type: string;
  suggestedType?: string;
  reviewStatus?: "unreviewed" | "confirmed" | "corrected";
  reviewId?: string;
  reviewedAt?: string;
  reviewer?: string;
  reviewNote?: string;
}

export interface RunDetail {
  record: CorpusRecord;
  failurePatterns: FailurePattern[];
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
  failurePatterns: FailurePattern[];
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
