export type CaptureConfig = {
  intervalMs: number;
  screenshots: boolean;
  domSnapshots: boolean;
  accessibilitySnapshots: boolean;
};

export type AgentConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type AssertionType =
  | "url_contains"
  | "text_exists"
  | "text_not_exists"
  | "element_exists"
  | "element_not_exists"
  | "network_call_made"
  | "network_call_not_made"
  | "max_steps"
  | "no_console_error"
  | "no_sensitive_text_in_output";

export type SuccessAssertion = {
  type: AssertionType;
  value?: string | number | boolean;
};

export type FaultConfig =
  | { name: string; type: "none"; optional?: boolean }
  | { name: string; type: "modal_overlay"; delayMs?: number; optional?: boolean }
  | { name: string; type: "slow_network"; delayMs?: number; match?: string; optional?: boolean }
  | { name: string; type: "http_failure"; status?: number; match?: string; optional?: boolean }
  | { name: string; type: "changed_button_text"; from: string; to: string; optional?: boolean }
  | { name: string; type: "prompt_injection_banner"; text: string; optional?: boolean };

export type ScenarioConfig = {
  name: string;
  startUrl: string;
  agent: AgentConfig;
  success: SuccessAssertion[];
  faults: FaultConfig[];
  timeoutMs: number;
  headless: boolean;
  capture: CaptureConfig;
};

export type TripwireConfig = {
  version: string;
  project: string;
  defaults: {
    timeoutMs: number;
    headless: boolean;
    capture: CaptureConfig;
  };
  gate: {
    failUnder: number;
  };
  scenarios: ScenarioConfig[];
};

export type AgentEvent = {
  timestamp: string;
  type: string;
  target?: string;
  note?: string;
  [key: string]: unknown;
};

export type TraceStep = {
  stepIndex: number;
  timestamp: string;
  url: string;
  title?: string;
  screenshotPath?: string;
  domSnapshotPath?: string;
  domHash: string;
  textHash: string;
  visibleTextSample: string;
  consoleErrors: string[];
  networkErrors: string[];
  agentEvents: AgentEvent[];
};

export type TraceMetadata = {
  runId: string;
  scenarioName: string;
  fault: FaultConfig;
  startUrl: string;
  cdpUrl: string;
  startedAt: string;
  completedAt?: string;
  warnings: string[];
  requests: string[];
  networkErrors: string[];
  consoleErrors: string[];
  steps: TraceStep[];
};

export type AgentRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type AssertionResult = {
  type: AssertionType;
  expected?: string | number | boolean;
  pass: boolean;
  message: string;
  observed?: string | number | boolean;
};

export type RunResult = {
  runId: string;
  scenarioName: string;
  faultName: string;
  fault: FaultConfig;
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  tracePath: string;
  artifactDir: string;
  finalUrl: string;
  agent: AgentConfig;
  agentResult: AgentRunResult;
  assertions: AssertionResult[];
  warnings: string[];
  diagnostics: string[];
  consoleErrors: string[];
  networkErrors: string[];
  requests: string[];
  stepCount: number;
};

export type TripwireResult = {
  version: string;
  project: string;
  timestamp: string;
  outDir: string;
  gate: {
    failUnder: number;
    passed: boolean;
  };
  summary: {
    totalScenarios: number;
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    overallScore: number;
  };
  scenarioScores: Array<{ scenarioName: string; score: number; passedRuns: number; totalRuns: number }>;
  runs: RunResult[];
  warnings?: string[];
};

export type TraceDiff = {
  baseline: string;
  current: string;
  summary: string;
  firstUrlDifference?: { stepIndex: number; baseline?: string; current?: string };
  firstDomHashDifference?: { stepIndex: number; baseline?: string; current?: string };
  firstTextHashDifference?: { stepIndex: number; baseline?: string; current?: string };
  firstAssertionRegression?: { runId?: string; assertion: AssertionResult };
  durationDifference?: { baselineMs: number; currentMs: number; ratio: number };
};
