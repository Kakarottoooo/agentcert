import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentCertCorpusRecord, FailurePattern } from "./corpus.js";
import { openCorpusStore, type CorpusStoreOptions } from "./corpus-store.js";
import {
  applyFailureReviews,
  appendFailureReview,
  createFailureReview,
  findFailurePattern,
  parseFailureReviewStatus,
  parseFailureType,
  readFailureReviews,
} from "./failure-review.js";
import { buildMonitorSnapshot } from "./monitor.js";

export interface ServeOptions {
  host: string;
  port: number;
  subject: string;
  detailUrl?: string;
  staticDir: string;
  artifactRoot: string;
  store: CorpusStoreOptions;
  reviewsPath?: string;
}

export interface RunDetail {
  record: AgentCertCorpusRecord;
  failurePatterns: FailurePattern[];
  assertions: TripwireAssertion[];
  timeline: EvidenceTimelineItem[];
  artifacts: EvidenceArtifact[];
  traceSummary?: TraceSummary;
  finalUrl?: string;
  diagnostics: string[];
  warnings: string[];
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

interface TripwireAssertion {
  type: string;
  pass: boolean;
  message: string;
  expected?: unknown;
  observed?: unknown;
}

interface TraceSummary {
  stepCount: number;
  firstStepText?: string;
  lastStepText?: string;
  firstDivergenceStep?: number;
}

interface TripwireTrace {
  steps?: Array<{
    stepIndex?: number;
    timestamp?: string;
    screenshotPath?: string;
    domSnapshotPath?: string;
    visibleTextSample?: string;
    consoleErrors?: unknown[];
    networkErrors?: unknown[];
    agentEvents?: Array<{ timestamp?: string; type?: string; target?: string; note?: string }>;
  }>;
  consoleErrors?: unknown[];
  networkErrors?: unknown[];
  warnings?: unknown[];
}

interface TripwireResult {
  runs?: Array<{
    runId?: string;
    finalUrl?: string;
    assertions?: TripwireAssertion[];
    warnings?: string[];
    diagnostics?: string[];
    consoleErrors?: unknown[];
    networkErrors?: unknown[];
  }>;
}

export async function serveAgentCertMonitor(options: ServeOptions): Promise<void> {
  const staticRoot = resolve(options.staticDir);
  const artifactRoot = resolve(options.artifactRoot);
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, options, staticRoot, artifactRoot);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(options.port, options.host, resolveListen));
  const address = `http://${options.host}:${options.port}`;
  process.stdout.write(`AgentCert Monitor server listening at ${address}\n`);
  process.stdout.write(`Serving dashboard from ${staticRoot}\n`);
  process.stdout.write(`Serving artifacts from ${artifactRoot}\n`);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServeOptions,
  staticRoot: string,
  artifactRoot: string,
): Promise<void> {
  if (!request.url) {
    sendJson(response, 400, { error: "Missing URL." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
  if (url.pathname === "/api/health") {
    await withStore(options.store, async (store) => {
      sendJson(response, 200, {
        ok: true,
        subject: options.subject,
        store: { kind: store.kind, description: store.description },
        artifactRoot,
      });
    });
    return;
  }

  if (url.pathname === "/api/monitor") {
    await withStore(options.store, async (store) => {
      const records = applyFailureReviews(await store.readAll(), await readFailureReviews(options.reviewsPath));
      sendJson(response, 200, buildMonitorSnapshot(records, { subject: options.subject, detailUrl: options.detailUrl }));
    });
    return;
  }

  if (url.pathname === "/api/runs") {
    await withStore(options.store, async (store) => {
      const records = applyFailureReviews(await store.readAll(), await readFailureReviews(options.reviewsPath));
      sendJson(response, 200, { runs: records.sort((left, right) => right.timestamp.localeCompare(left.timestamp)) });
    });
    return;
  }

  const reviewRoute = matchRunReviewRoute(url.pathname);
  if (reviewRoute && request.method === "POST") {
    await handleFailureReviewPost(request, response, options, artifactRoot, reviewRoute.runId);
    return;
  }

  if (url.pathname.startsWith("/api/runs/") && request.method !== "POST") {
    const runId = decodeURIComponent(url.pathname.slice("/api/runs/".length));
    await withStore(options.store, async (store) => {
      const records = applyFailureReviews(await store.readAll(), await readFailureReviews(options.reviewsPath));
      const record = records.find((item) => item.id === runId || item.runId === runId);
      if (!record) {
        sendJson(response, 404, { error: `Run ${runId} was not found.` });
        return;
      }
      sendJson(response, 200, await buildRunDetail(record, artifactRoot));
    });
    return;
  }

  if (url.pathname === "/api/artifacts") {
    await serveArtifact(response, artifactRoot, url.searchParams.get("path"));
    return;
  }

  await serveStatic(response, staticRoot, url.pathname);
}

async function handleFailureReviewPost(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServeOptions,
  artifactRoot: string,
  runId: string,
): Promise<void> {
  const reviewsPath = options.reviewsPath;
  if (!reviewsPath) {
    sendJson(response, 400, { error: "This server was not configured with a failure review ledger path." });
    return;
  }

  const body = await readJsonBody(request);
  const patternKey = stringField(body, "patternKey");
  const type = parseFailureType(stringField(body, "type"));
  const reviewer = stringField(body, "reviewer") ?? "local-reviewer";
  const note = stringField(body, "note");
  const explicitStatus = stringField(body, "status");

  if (!patternKey) {
    sendJson(response, 400, { error: "Missing patternKey." });
    return;
  }

  await withStore(options.store, async (store) => {
    const records = await store.readAll();
    const record = records.find((item) => item.id === runId || item.runId === runId);
    if (!record) {
      sendJson(response, 404, { error: `Run ${runId} was not found.` });
      return;
    }

    const target = {
      patternKey,
      recordId: record.id,
      runId: record.runId,
      product: record.product,
      scenarioName: record.scenarioName,
      faultName: record.faultName,
    };
    const matched = findFailurePattern(records, target);
    if (!matched) {
      sendJson(response, 404, { error: `Failure pattern ${patternKey} was not found on run ${runId}.` });
      return;
    }

    const suggestedType = matched.pattern.suggestedType ?? matched.pattern.type;
    const review = createFailureReview({
      target,
      type,
      status: parseFailureReviewStatus(explicitStatus, type, suggestedType),
      suggestedType,
      reviewer,
      note,
    });
    await appendFailureReview(reviewsPath, review);
    const updated = applyFailureReviews(records, await readFailureReviews(reviewsPath));
    await store.append(updated, { replace: true });
    const updatedRecord = updated.find((item) => item.id === record.id) ?? record;
    sendJson(response, 200, await buildRunDetail(updatedRecord, artifactRoot));
  });
}

export async function buildRunDetail(record: AgentCertCorpusRecord, artifactRoot: string): Promise<RunDetail> {
  const root = resolve(artifactRoot);
  const tracePath = normalizeArtifactPath(record.artifacts.trace);
  const resultPath = normalizeArtifactPath(record.artifacts.result);
  const trace = tracePath ? await readJsonIfExists<TripwireTrace>(join(root, tracePath)) : undefined;
  const result = await readTripwireResult(root, resultPath);
  const tripwireRun = result?.runs?.find((run) => run.runId === record.runId);
  const assertions = tripwireRun?.assertions ?? assertionsFromFailurePatterns(record.failurePatterns);
  const artifacts = await collectArtifacts(record, root, trace);

  return {
    record,
    failurePatterns: record.failurePatterns,
    assertions,
    timeline: buildTimeline(record, assertions, trace),
    artifacts,
    traceSummary: traceSummary(trace),
    finalUrl: tripwireRun?.finalUrl ?? stringMetadata(record.metadata, "finalUrl"),
    diagnostics: stringArray(tripwireRun?.diagnostics ?? record.metadata?.diagnostics),
    warnings: stringArray(tripwireRun?.warnings ?? record.metadata?.warnings ?? trace?.warnings),
  };
}

function buildTimeline(
  record: AgentCertCorpusRecord,
  assertions: TripwireAssertion[],
  trace: TripwireTrace | undefined,
): EvidenceTimelineItem[] {
  const failedAssertions = assertions.filter((assertion) => assertion.pass === false);
  const timeline: EvidenceTimelineItem[] = failedAssertions.map((assertion) => ({
    kind: "failure",
    title: "Assertion failure",
    timestamp: record.timestamp,
    message: `${assertion.message}${assertion.observed === undefined ? "" : ` Observed: ${stringifyShort(assertion.observed)}`}`,
  }));

  const steps = trace?.steps ?? [];
  const firstChangedStep = firstDivergenceStep(steps);
  if (firstChangedStep) {
    timeline.push({
      kind: "page-state",
      title: "First observed page divergence",
      timestamp: firstChangedStep.timestamp,
      stepIndex: firstChangedStep.stepIndex,
      message: firstChangedStep.visibleTextSample ?? "The page state changed before the task reached the expected outcome.",
      artifactPath: firstChangedStep.screenshotPath,
    });
  }

  for (const event of steps.flatMap((step) =>
    (step.agentEvents ?? []).map((agentEvent) => ({
      ...agentEvent,
      stepIndex: step.stepIndex,
    })),
  )) {
    timeline.push({
      kind: "agent-action",
      title: `Agent ${event.type ?? "event"}`,
      timestamp: event.timestamp,
      stepIndex: event.stepIndex,
      message: [event.target, event.note].filter(Boolean).join(" - "),
    });
  }

  for (const [index, item] of [...(trace?.networkErrors ?? []), ...steps.flatMap((step) => step.networkErrors ?? [])].entries()) {
    timeline.push({ kind: "network", title: "Network error", message: stringifyShort(item), stepIndex: index + 1 });
  }
  for (const [index, item] of [...(trace?.consoleErrors ?? []), ...steps.flatMap((step) => step.consoleErrors ?? [])].entries()) {
    timeline.push({ kind: "console", title: "Console error", message: stringifyShort(item), stepIndex: index + 1 });
  }

  return timeline.sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""));
}

async function collectArtifacts(
  record: AgentCertCorpusRecord,
  root: string,
  trace: TripwireTrace | undefined,
): Promise<EvidenceArtifact[]> {
  const artifactPaths = new Map<string, EvidenceArtifact["kind"]>();
  const tracePath = normalizeArtifactPath(record.artifacts.trace);
  const resultPath = normalizeArtifactPath(record.artifacts.result);
  const artifactDir = normalizeArtifactPath(record.artifacts.artifactDir);
  if (tracePath) artifactPaths.set(tracePath, "trace");
  if (resultPath) artifactPaths.set(resultPath, "json");
  if (artifactDir) artifactPaths.set(join(artifactDir, "agent-events.jsonl"), "events");

  for (const step of trace?.steps ?? []) {
    if (step.screenshotPath && tracePath) artifactPaths.set(join(dirnameLike(tracePath), step.screenshotPath), "screenshot");
    if (step.domSnapshotPath && tracePath) artifactPaths.set(join(dirnameLike(tracePath), step.domSnapshotPath), "dom");
  }

  const artifacts: EvidenceArtifact[] = [];
  for (const [path, kind] of artifactPaths) {
    const normalized = normalizeArtifactPath(path);
    if (!normalized) continue;
    const fullPath = resolveInside(root, normalized);
    if (!fullPath) continue;
    const fileStat = await stat(fullPath).catch(() => undefined);
    if (!fileStat?.isFile()) continue;
    artifacts.push({
      label: normalized.split(/[\\/]/).slice(-2).join("/"),
      kind,
      path: normalized,
      url: `/api/artifacts?path=${encodeURIComponent(normalized)}`,
      sizeBytes: fileStat.size,
    });
  }

  return artifacts.sort((left, right) => artifactKindRank(left.kind) - artifactKindRank(right.kind) || left.path.localeCompare(right.path));
}

async function serveArtifact(response: ServerResponse, artifactRoot: string, path: string | null): Promise<void> {
  if (!path) {
    sendJson(response, 400, { error: "Missing artifact path." });
    return;
  }
  const normalized = normalizeArtifactPath(path);
  const fullPath = normalized ? resolveInside(artifactRoot, normalized) : undefined;
  if (!fullPath) {
    sendJson(response, 403, { error: "Artifact path is outside the artifact root." });
    return;
  }

  try {
    const file = await readFile(fullPath);
    response.writeHead(200, {
      "content-type": mimeType(fullPath),
      "cache-control": "no-cache",
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Artifact was not found." });
  }
}

async function serveStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = resolveInside(staticRoot, requested);
  if (!fullPath) {
    sendJson(response, 403, { error: "Static path is outside the dashboard root." });
    return;
  }

  try {
    const fileStat = await stat(fullPath);
    if (fileStat.isDirectory()) {
      await sendFile(response, join(fullPath, "index.html"));
      return;
    }
    await sendFile(response, fullPath);
  } catch {
    await sendFile(response, join(staticRoot, "index.html"));
  }
}

async function sendFile(response: ServerResponse, path: string): Promise<void> {
  const file = await readFile(path);
  response.writeHead(200, { "content-type": mimeType(path), "cache-control": "no-cache" });
  response.end(file);
}

async function withStore<T>(options: CorpusStoreOptions, callback: (store: Awaited<ReturnType<typeof openCorpusStore>>) => Promise<T>): Promise<T> {
  const store = await openCorpusStore(options);
  try {
    return await callback(store);
  } finally {
    await store.close();
  }
}

async function readTripwireResult(root: string, resultPath: string | undefined): Promise<TripwireResult | undefined> {
  const candidates = [resultPath, "tripwire-result.json"].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const normalized = normalizeArtifactPath(candidate);
    const fullPath = normalized ? resolveInside(root, normalized) : undefined;
    const result = fullPath ? await readJsonIfExists<TripwireResult>(fullPath) : undefined;
    if (result) return result;
  }
  return undefined;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function assertionsFromFailurePatterns(patterns: FailurePattern[]): TripwireAssertion[] {
  return patterns.map((pattern) => ({ type: pattern.key, pass: false, message: pattern.message }));
}

function traceSummary(trace: TripwireTrace | undefined): TraceSummary | undefined {
  const steps = trace?.steps ?? [];
  if (steps.length === 0) return undefined;
  return {
    stepCount: steps.length,
    firstStepText: steps[0]?.visibleTextSample,
    lastStepText: steps[steps.length - 1]?.visibleTextSample,
    firstDivergenceStep: firstDivergenceStep(steps)?.stepIndex,
  };
}

function firstDivergenceStep(steps: NonNullable<TripwireTrace["steps"]>): NonNullable<TripwireTrace["steps"]>[number] | undefined {
  const firstHash = steps[0]?.visibleTextSample;
  return steps.find((step) => step.visibleTextSample && step.visibleTextSample !== firstHash);
}

function normalizeArtifactPath(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const normalized = input.replace(/\\/g, "/");
  if (normalized.includes("..")) return undefined;
  if (normalized.startsWith("packages/tripwire-ci/.tripwire/public-demo/")) {
    return normalized.slice("packages/tripwire-ci/.tripwire/public-demo/".length);
  }
  return normalized.replace(/^\/+/, "");
}

function resolveInside(root: string, path: string): string | undefined {
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) {
    return undefined;
  }
  return fullPath;
}

function dirnameLike(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function artifactKindRank(kind: EvidenceArtifact["kind"]): number {
  return ["screenshot", "dom", "trace", "json", "events", "report", "other"].indexOf(kind);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matchRunReviewRoute(pathname: string): { runId: string } | undefined {
  const suffix = "/failure-reviews";
  if (!pathname.startsWith("/api/runs/") || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const encoded = pathname.slice("/api/runs/".length, -suffix.length);
  return { runId: decodeURIComponent(encoded) };
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
}

function stringifyShort(input: unknown): string {
  const value = typeof input === "string" ? input : JSON.stringify(input);
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
      return "application/x-ndjson; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export function dashboardFileUrl(staticDir: string): string {
  return pathToFileURL(resolve(staticDir, "index.html")).toString();
}
