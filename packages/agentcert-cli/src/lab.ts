import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

export type LabAgentKind = "reference-agent" | "public-open-source-agent" | "custom-agent";
export type LabAgentStatus = "completed" | "missing";

export interface RobustnessLabConfig {
  schemaVersion: "1";
  name: string;
  description?: string;
  agents: LabAgentConfig[];
  limitations?: string[];
}

export interface LabAgentConfig {
  id: string;
  name: string;
  kind: LabAgentKind;
  repositoryUrl?: string;
  adapterPath?: string;
  configPath?: string;
  resultPath?: string;
  reportPath?: string;
  publicPathPrefix?: string;
  requiresModelKey?: boolean;
  includedInPublicSnapshot?: boolean;
  notes?: string;
}

export interface RobustnessLabSnapshot {
  schemaVersion: "1";
  kind: "agentcert.real_agent_robustness_lab";
  generatedAt: string;
  name: string;
  description?: string;
  summary: {
    agentCount: number;
    completedAgentCount: number;
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    passRate: number;
    faultCount: number;
  };
  agents: LabAgentSummary[];
  faults: LabFaultSummary[];
  matrix: LabMatrixCell[];
  limitations: string[];
}

export interface LabAgentSummary {
  id: string;
  name: string;
  kind: LabAgentKind;
  status: LabAgentStatus;
  repositoryUrl?: string;
  adapterPath?: string;
  configPath?: string;
  resultPath?: string;
  reportPath?: string;
  requiresModelKey: boolean;
  includedInPublicSnapshot: boolean;
  score?: number;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  passRate: number;
  notes?: string;
}

export interface LabFaultSummary {
  faultName: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  passRate: number;
}

export interface LabMatrixCell {
  agentId: string;
  agentName: string;
  scenarioName?: string;
  faultName: string;
  status: "passed" | "failed";
  durationMs?: number;
  stepCount?: number;
  finalUrl?: string;
  primaryFailure?: string;
  firstDivergence?: LabFirstDivergence;
  tracePath?: string;
  reportPath?: string;
  screenshotPath?: string;
}

export interface LabFirstDivergence {
  kind: "url" | "text" | "dom" | "step-count" | "assertion";
  stepIndex?: number;
  baseline?: string;
  current?: string;
  note: string;
  screenshotPath?: string;
  domSnapshotPath?: string;
}

interface TripwireResult {
  summary?: {
    totalRuns?: number;
    passedRuns?: number;
    failedRuns?: number;
    overallScore?: number;
  };
  runs?: TripwireRun[];
}

interface TripwireRun {
  runId?: string;
  scenarioName?: string;
  faultName?: string;
  status?: string;
  durationMs?: number;
  stepCount?: number;
  tracePath?: string;
  finalUrl?: string;
  assertions?: Array<{ pass?: boolean; message?: string }>;
}

interface TripwireTrace {
  steps?: TripwireTraceStep[];
}

interface TripwireTraceStep {
  stepIndex?: number;
  url?: string;
  screenshotPath?: string;
  domSnapshotPath?: string;
  domHash?: string;
  textHash?: string;
  visibleTextSample?: string;
}

export async function buildRobustnessLabSnapshot(config: RobustnessLabConfig, cwd = process.cwd()): Promise<RobustnessLabSnapshot> {
  const agents: LabAgentSummary[] = [];
  const matrix: LabMatrixCell[] = [];

  for (const agent of config.agents) {
    const result = agent.resultPath ? await readJsonIfExists<TripwireResult>(resolve(cwd, agent.resultPath)) : undefined;
    if (!result) {
      agents.push({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        status: "missing",
        repositoryUrl: agent.repositoryUrl,
        adapterPath: agent.adapterPath,
        configPath: agent.configPath,
        resultPath: agent.resultPath,
        reportPath: agent.reportPath,
        requiresModelKey: agent.requiresModelKey ?? false,
        includedInPublicSnapshot: agent.includedInPublicSnapshot ?? false,
        totalRuns: 0,
        passedRuns: 0,
        failedRuns: 0,
        passRate: 0,
        notes: agent.notes,
      });
      continue;
    }

    const runs = result.runs ?? [];
    const traces = await loadTracesForRuns(agent, cwd, runs);
    const passedRuns = numberValue(result.summary?.passedRuns) ?? runs.filter((run) => run.status === "passed").length;
    const totalRuns = numberValue(result.summary?.totalRuns) ?? runs.length;
    const failedRuns = numberValue(result.summary?.failedRuns) ?? Math.max(0, totalRuns - passedRuns);
    const passRate = ratio(passedRuns, totalRuns);
    agents.push({
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      status: "completed",
      repositoryUrl: agent.repositoryUrl,
      adapterPath: agent.adapterPath,
      configPath: agent.configPath,
      resultPath: agent.resultPath,
      reportPath: agent.reportPath,
      requiresModelKey: agent.requiresModelKey ?? false,
      includedInPublicSnapshot: agent.includedInPublicSnapshot ?? false,
      score: scoreValue(result.summary?.overallScore),
      totalRuns,
      passedRuns,
      failedRuns,
      passRate,
      notes: agent.notes,
    });

    for (const run of runs) {
      const tracePath = stringValue(run.tracePath);
      const scenarioName = stringValue(run.scenarioName);
      const faultName = stringValue(run.faultName) ?? "unknown";
      const trace = tracePath ? traces.get(traceKey(scenarioName, faultName)) : undefined;
      const cleanTrace = faultName === "clean" ? undefined : traces.get(traceKey(scenarioName, "clean"));
      matrix.push({
        agentId: agent.id,
        agentName: agent.name,
        scenarioName,
        faultName,
        status: run.status === "passed" ? "passed" : "failed",
        durationMs: numberValue(run.durationMs),
        stepCount: numberValue(run.stepCount),
        finalUrl: stringValue(run.finalUrl),
        primaryFailure: firstFailure(run),
        firstDivergence: firstDivergence(agent, tracePath, trace, cleanTrace, run),
        tracePath: publicArtifactPath(agent, tracePath),
        reportPath: publicArtifactPath(agent, agent.reportPath),
        screenshotPath: tracePath ? screenshotPathFor(agent, tracePath, trace) : undefined,
      });
    }
  }

  const completedAgents = agents.filter((agent) => agent.status === "completed");
  const passedRuns = matrix.filter((cell) => cell.status === "passed").length;
  const failedRuns = matrix.length - passedRuns;
  return {
    schemaVersion: "1",
    kind: "agentcert.real_agent_robustness_lab",
    generatedAt: new Date().toISOString(),
    name: config.name,
    description: config.description,
    summary: {
      agentCount: agents.length,
      completedAgentCount: completedAgents.length,
      totalRuns: matrix.length,
      passedRuns,
      failedRuns,
      passRate: ratio(passedRuns, matrix.length),
      faultCount: new Set(matrix.map((cell) => cell.faultName)).size,
    },
    agents,
    faults: summarizeFaults(matrix),
    matrix,
    limitations: config.limitations ?? [],
  };
}

export async function writeRobustnessLabSnapshot(path: string, snapshot: RobustnessLabSnapshot): Promise<void> {
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function renderRobustnessLabSummary(snapshot: RobustnessLabSnapshot): string {
  const lines = [
    "# Real Agent Robustness Lab",
    "",
    `Agents: ${snapshot.summary.completedAgentCount}/${snapshot.summary.agentCount} completed`,
    `Runs: ${snapshot.summary.passedRuns}/${snapshot.summary.totalRuns} passed (${Math.round(snapshot.summary.passRate * 100)}%)`,
    `Faults: ${snapshot.summary.faultCount}`,
    "",
    "## Agents",
    ...snapshot.agents.map((agent) =>
      `- ${agent.name}: ${agent.status}${agent.status === "completed" ? `, ${agent.passedRuns}/${agent.totalRuns} passed` : ""}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export async function readRobustnessLabConfig(path: string): Promise<RobustnessLabConfig> {
  return (await readJson(path)) as RobustnessLabConfig;
}

function summarizeFaults(matrix: LabMatrixCell[]): LabFaultSummary[] {
  const buckets = new Map<string, { totalRuns: number; passedRuns: number }>();
  for (const cell of matrix) {
    const bucket = buckets.get(cell.faultName) ?? { totalRuns: 0, passedRuns: 0 };
    bucket.totalRuns += 1;
    if (cell.status === "passed") bucket.passedRuns += 1;
    buckets.set(cell.faultName, bucket);
  }
  return [...buckets.entries()]
    .map(([faultName, bucket]) => ({
      faultName,
      totalRuns: bucket.totalRuns,
      passedRuns: bucket.passedRuns,
      failedRuns: bucket.totalRuns - bucket.passedRuns,
      passRate: ratio(bucket.passedRuns, bucket.totalRuns),
    }))
    .sort((left, right) => left.passRate - right.passRate || left.faultName.localeCompare(right.faultName));
}

async function loadTracesForRuns(agent: LabAgentConfig, cwd: string, runs: TripwireRun[]): Promise<Map<string, TripwireTrace>> {
  const traces = new Map<string, TripwireTrace>();
  if (!agent.resultPath) return traces;
  const resultDir = dirname(resolve(cwd, agent.resultPath));
  for (const run of runs) {
    const scenarioName = stringValue(run.scenarioName);
    const faultName = stringValue(run.faultName) ?? "unknown";
    const tracePath = stringValue(run.tracePath);
    if (!tracePath) continue;
    const trace = await readJsonIfExists<TripwireTrace>(join(resultDir, tracePath));
    if (trace) traces.set(traceKey(scenarioName, faultName), trace);
  }
  return traces;
}

function screenshotPathFor(agent: LabAgentConfig, tracePath: string, trace: TripwireTrace | undefined): string | undefined {
  const screenshot = [...(trace?.steps ?? [])].reverse().find((step) => step.screenshotPath)?.screenshotPath;
  if (!screenshot) return undefined;
  return publicArtifactPath(agent, posix.join(posix.dirname(slashPath(tracePath)), slashPath(screenshot)));
}

function firstDivergence(
  agent: LabAgentConfig,
  tracePath: string | undefined,
  trace: TripwireTrace | undefined,
  cleanTrace: TripwireTrace | undefined,
  run: TripwireRun,
): LabFirstDivergence | undefined {
  if (tracePath && trace?.steps && cleanTrace?.steps) {
    const maxSteps = Math.max(trace.steps.length, cleanTrace.steps.length);
    for (let index = 0; index < maxSteps; index += 1) {
      const current = trace.steps[index];
      const baseline = cleanTrace.steps[index];
      if (!current || !baseline) {
        return divergence(agent, tracePath, current, baseline, "step-count", "Trace length diverged from the clean run.");
      }
      if (current.url !== baseline.url) {
        return divergence(agent, tracePath, current, baseline, "url", "First observed URL diverged from the clean run.");
      }
      if (current.textHash !== baseline.textHash) {
        return divergence(agent, tracePath, current, baseline, "text", "First visible text snapshot diverged from the clean run.");
      }
      if (current.domHash !== baseline.domHash) {
        return divergence(agent, tracePath, current, baseline, "dom", "First DOM snapshot diverged from the clean run.");
      }
    }
  }

  const failure = firstFailure(run);
  if (!failure) return undefined;
  return {
    kind: "assertion",
    note: failure,
  };
}

function divergence(
  agent: LabAgentConfig,
  tracePath: string,
  current: TripwireTraceStep | undefined,
  baseline: TripwireTraceStep | undefined,
  kind: LabFirstDivergence["kind"],
  note: string,
): LabFirstDivergence {
  return {
    kind,
    stepIndex: current?.stepIndex ?? baseline?.stepIndex,
    baseline: divergenceValue(kind, baseline),
    current: divergenceValue(kind, current),
    note,
    screenshotPath: current?.screenshotPath
      ? publicArtifactPath(agent, posix.join(posix.dirname(slashPath(tracePath)), slashPath(current.screenshotPath)))
      : undefined,
    domSnapshotPath: current?.domSnapshotPath
      ? publicArtifactPath(agent, posix.join(posix.dirname(slashPath(tracePath)), slashPath(current.domSnapshotPath)))
      : undefined,
  };
}

function divergenceValue(kind: LabFirstDivergence["kind"], step: TripwireTraceStep | undefined): string | undefined {
  if (!step) return undefined;
  if (kind === "url") return step.url;
  if (kind === "text") return step.visibleTextSample ?? step.textHash;
  if (kind === "dom") return step.domHash;
  return step.stepIndex === undefined ? undefined : `step ${step.stepIndex}`;
}

function traceKey(scenarioName: string | undefined, faultName: string): string {
  return `${scenarioName ?? "unknown"}:${faultName}`;
}

function publicArtifactPath(agent: LabAgentConfig, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = slashPath(path);
  const prefix = agent.publicPathPrefix?.replace(/\/?$/, "/");
  if (!prefix) return normalized;
  if (normalized.startsWith(prefix)) return normalized;
  return `${prefix}${normalized}`;
}

function firstFailure(run: TripwireRun): string | undefined {
  return run.assertions?.find((assertion) => assertion.pass === false)?.message;
}

function scoreValue(input: unknown): number | undefined {
  const value = numberValue(input);
  if (value === undefined) return undefined;
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw);
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    await access(path);
    return (await readJson(path)) as T;
  } catch {
    return undefined;
  }
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}
