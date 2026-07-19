import { createHash } from "node:crypto";
import type { AgentCertBundle } from "./types.js";
import { serializeHostedEvidenceBundle } from "./artifact-manifest.js";
import {
  MAX_REPORTED_COMPANION_ARTIFACT_SKIPS,
  type PreparedCompanionArtifact,
  type SkippedCompanionArtifact,
} from "./companion-artifacts.js";

export interface PushEvidenceOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  bundle: AgentCertBundle;
  evidenceBytes: Uint8Array;
  fileName?: string;
  externalId?: string;
  companionArtifacts?: PreparedCompanionArtifact[];
  skippedCompanionArtifacts?: SkippedCompanionArtifact[];
  assurance?: {
    caseId: string;
    trigger: "pull_request" | "release" | "nightly";
    scope: Record<string, unknown>;
  };
  verifyContinuousAssurance?: boolean;
  fetch?: typeof fetch;
}

export interface PushEvidenceResult {
  runId: string;
  evidenceId: string;
  externalId: string;
  artifactsUploaded: number;
  artifactsSkipped: number;
  artifactBytesUploaded: number;
  continuousAssuranceHealth?: ContinuousAssuranceHealth;
}

export interface ContinuousAssuranceHealth {
  schemaVersion: "agentcert.continuous_assurance_health.v0.1";
  healthy: boolean;
  status: "CURRENT" | "REVALIDATION_REQUIRED" | "SUSPENDED" | "EXPIRED" | "UNKNOWN";
  checkedAt: string;
  run: { id: string; externalId: string; status: string };
  assurance: {
    caseId?: string;
    trigger?: "pull_request" | "release" | "nightly";
    scopeFingerprintSha256?: string;
    authoritative?: boolean;
    outcome?: string;
    firstAuthoritativeCurrentAt?: string;
    timeToFirstCurrentMs?: number;
  };
  evidence: {
    status: "complete" | "partial" | "rejected" | "unknown";
    declared: number;
    matched: number;
    reasons: string[];
  };
  diagnostics: Array<{ code: string; message: string; recovery: string }>;
}

export interface VerifyControlPlaneOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface VerifiedControlPlaneConnection {
  projectId: string;
  runs: number;
  evidence: number;
}

export class ControlPlaneRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = "ControlPlaneRequestError";
  }
}

export async function verifyControlPlaneConnection(
  options: VerifyControlPlaneOptions,
): Promise<VerifiedControlPlaneConnection> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const request = options.fetch ?? fetch;
  try {
    const overview = await requestJson<{
      projectId: string;
      summary: { runs?: number; evidence?: number };
    }>(request, `${baseUrl}/v1/projects/${encodeURIComponent(options.projectId)}/overview`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
    });
    return {
      projectId: overview.projectId,
      runs: overview.summary.runs ?? 0,
      evidence: overview.summary.evidence ?? 0,
    };
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 401) {
      throw new Error("AgentCert API key was rejected. Create a new project API key and try again.");
    }
    if (error instanceof ControlPlaneRequestError && error.status === 403) {
      throw new Error(`AgentCert API key cannot access project ${options.projectId}. Check the project ID and key scope.`);
    }
    if (error instanceof ControlPlaneRequestError && error.status === 404) {
      throw new Error(`AgentCert project ${options.projectId} was not found.`);
    }
    throw error;
  }
}

export async function pushEvidenceToControlPlane(options: PushEvidenceOptions): Promise<PushEvidenceResult> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!baseUrl || !options.projectId || !options.apiKey) {
    throw new Error("baseUrl, projectId, and apiKey are required to push evidence.");
  }
  const request = options.fetch ?? fetch;
  const projectUrl = `${baseUrl}/v1/projects/${encodeURIComponent(options.projectId)}`;
  const companionArtifacts = options.companionArtifacts ?? [];
  const hostedEvidence = options.companionArtifacts === undefined && options.bundle.artifactManifest
    ? {
      bundle: options.bundle,
      bytes: new TextEncoder().encode(`${JSON.stringify(options.bundle, null, 2)}\n`),
    }
    : serializeHostedEvidenceBundle(options.bundle, companionArtifacts);
  const bundle = hostedEvidence.bundle;
  const externalId = options.externalId ?? bundle.runId;
  const kind = hostedRunKind(bundle);
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const trace = hostedTrace(options.projectId, externalId);
  const observationEvents = buildHostedObservationEvents(bundle, trace);

  const run = await requestJson<{ id: string }>(request, `${projectUrl}/runs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      externalId,
      kind,
      schemaVersion: bundle.schemaVersion,
      startedAt: bundle.generatedAt,
      traceId: trace.traceId,
      rootSpanId: trace.rootSpanId,
      metadata: {
        subject: bundle.subject,
        products: bundle.summary.products,
      },
      assurance: options.assurance,
    }),
  });

  await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      events: observationEvents,
    }),
  });

  const query = new URLSearchParams({
    fileName: options.fileName ?? "agentcert-evidence.json",
    kind: "evidence_bundle",
    schemaVersion: bundle.schemaVersion,
    runId: run.id,
  });
  const evidence = await requestJson<{ id: string }>(request, `${projectUrl}/evidence?${query}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: new Uint8Array(hostedEvidence.bytes).buffer as ArrayBuffer,
  });

  const skippedArtifacts = options.skippedCompanionArtifacts ?? [];
  let artifactBytesUploaded = 0;
  for (const artifact of companionArtifacts) {
    const artifactQuery = new URLSearchParams({
      fileName: artifact.fileName,
      kind: artifact.kind,
      schemaVersion: bundle.schemaVersion,
      runId: run.id,
      sourcePath: artifact.sourcePath,
    });
    await requestJson(request, `${projectUrl}/evidence?${artifactQuery}`, {
      method: "POST",
      headers: { ...headers, "content-type": artifact.contentType },
      body: new Uint8Array(artifact.bytes).buffer as ArrayBuffer,
    });
    artifactBytesUploaded += artifact.bytes.byteLength;
  }

  await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        sequence: observationEvents.length,
        type: "agentcert.evidence.uploaded",
        actor: "agentcert-cli",
        occurredAt: bundle.generatedAt,
        payload: {
          evidenceId: evidence.id,
          bundleSchemaVersion: bundle.schemaVersion,
          uploadedCount: companionArtifacts.length,
          skippedCount: skippedArtifacts.length,
          uploadedBytes: artifactBytesUploaded,
          skipped: skippedArtifacts
            .slice(0, MAX_REPORTED_COMPANION_ARTIFACT_SKIPS)
            .map(({ sourcePath, reason }) => ({ sourcePath, reason })),
          skippedDetailsTruncated: skippedArtifacts.length > MAX_REPORTED_COMPANION_ARTIFACT_SKIPS,
        },
        traceId: trace.traceId,
        spanId: stableSpanId(`${trace.traceId}:evidence-uploaded`),
        parentSpanId: trace.rootSpanId,
      }],
    }),
  });

  const firstDivergence = bundle.evidence.find((item) => item.severity === "critical" || item.severity === "high")?.message;
  await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/complete`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      status: bundle.verdict.passed ? "passed" : "failed",
      score: bundle.verdict.score,
      summary: `${bundle.subject.name}: ${bundle.verdict.level}`,
      firstDivergence,
      completedAt: bundle.generatedAt,
      metadata: {
        evidenceId: evidence.id,
        evidenceSchemaVersion: bundle.schemaVersion,
        artifactManifestVersion: bundle.artifactManifest?.schemaVersion,
        companionArtifactsUploaded: companionArtifacts.length,
        companionArtifactsSkipped: skippedArtifacts.length,
        companionArtifactBytesUploaded: artifactBytesUploaded,
      },
    }),
  });

  const continuousAssuranceHealth = options.assurance && options.verifyContinuousAssurance
    ? await loadContinuousAssuranceHealth({
        baseUrl,
        projectId: options.projectId,
        apiKey: options.apiKey,
        runId: run.id,
        expectedCaseId: options.assurance.caseId,
        expectedScopeFingerprintSha256: scopeFingerprint(options.assurance.scope),
        fetch: request,
      })
    : undefined;

  return {
    runId: run.id,
    evidenceId: evidence.id,
    externalId,
    artifactsUploaded: companionArtifacts.length,
    artifactsSkipped: skippedArtifacts.length,
    artifactBytesUploaded,
    ...(continuousAssuranceHealth ? { continuousAssuranceHealth } : {}),
  };
}

export async function loadContinuousAssuranceHealth(options: {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  runId: string;
  expectedCaseId?: string;
  expectedScopeFingerprintSha256?: string;
  fetch?: typeof fetch;
}): Promise<ContinuousAssuranceHealth> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const request = options.fetch ?? fetch;
  const analysis = await requestJson<Record<string, unknown>>(request,
    `${baseUrl}/v1/projects/${encodeURIComponent(options.projectId)}/runs/${encodeURIComponent(options.runId)}/analysis`,
    { headers: { authorization: `Bearer ${options.apiKey}` } },
  );
  const run = object(analysis.run);
  const metadata = object(run.metadata);
  const binding = object(metadata.continuousAssurance);
  const reconciliation = object(binding.reconciliation);
  const completeness = object(analysis.evidenceCompleteness);
  const manifest = object(completeness.reconciliation);
  const runStatus = text(run.status) ?? "unknown";
  const nextStatus = assuranceStatus(reconciliation.nextStatus);
  const evidenceStatus = evidenceCompletenessStatus(completeness.status);
  const diagnostics: ContinuousAssuranceHealth["diagnostics"] = [];

  if (!text(binding.caseId)) diagnostics.push(diagnostic("assurance_binding_missing", "Hosted run has no continuous assurance binding.", "Regenerate the kit from an issued assurance case and rerun the workflow."));
  if (options.expectedCaseId && binding.caseId !== options.expectedCaseId) diagnostics.push(diagnostic("assurance_case_mismatch", "Hosted run is bound to a different assurance case.", "Use the unmodified generated workflow and case ID."));
  if (options.expectedScopeFingerprintSha256 && binding.scopeFingerprintSha256 !== options.expectedScopeFingerprintSha256) diagnostics.push(diagnostic("scope_fingerprint_mismatch", "Hosted scope fingerprint does not match the generated scope file.", "Restore the generated scope file or start a formal revalidation."));
  if (reconciliation.authoritative !== true) diagnostics.push(diagnostic("non_authoritative_trigger", "The Hosted reconciliation is prospective, not authoritative.", "Run the release or nightly workflow; pull requests cannot establish CURRENT."));
  if (reconciliation.outcome !== "current" || nextStatus !== "CURRENT") diagnostics.push(diagnostic("assurance_not_current", `Hosted reconciliation ended in ${nextStatus}.`, "Review changed scope components or failed tests, then revalidate before release."));
  if (runStatus !== "passed") diagnostics.push(diagnostic("run_not_passed", `Hosted run status is ${runStatus}.`, "Open the run trace, fix the first divergence, and rerun the same generated kit."));
  if (evidenceStatus !== "complete") diagnostics.push(diagnostic("evidence_incomplete", `Hosted evidence is ${evidenceStatus}.`, "Upload every declared companion artifact and verify manifest hashes before retrying."));

  return {
    schemaVersion: "agentcert.continuous_assurance_health.v0.1",
    healthy: diagnostics.length === 0,
    status: nextStatus,
    checkedAt: new Date().toISOString(),
    run: { id: text(run.id) ?? options.runId, externalId: text(run.externalId) ?? "unknown", status: runStatus },
    assurance: {
      caseId: text(binding.caseId),
      trigger: assuranceTrigger(binding.trigger),
      scopeFingerprintSha256: text(binding.scopeFingerprintSha256),
      authoritative: boolean(reconciliation.authoritative),
      outcome: text(reconciliation.outcome),
      firstAuthoritativeCurrentAt: text(reconciliation.firstAuthoritativeCurrentAt),
      timeToFirstCurrentMs: finiteNumber(reconciliation.timeToFirstCurrentMs),
    },
    evidence: {
      status: evidenceStatus,
      declared: finiteNumber(manifest.declared) ?? 0,
      matched: finiteNumber(manifest.matched) ?? 0,
      reasons: stringArray(completeness.reasons),
    },
    diagnostics,
  };
}

export function requireContinuousAssuranceCurrent(health: ContinuousAssuranceHealth): void {
  if (health.healthy) return;
  const details = health.diagnostics.map((item) => `${item.code}: ${item.message} ${item.recovery}`).join("\n");
  throw new Error(`Hosted continuous assurance did not reach CURRENT.\n${details}`);
}

function hostedRunKind(bundle: AgentCertBundle): "mcpbench" | "tripwire" | "release_gate" | "runtime" | "custom" {
  const products = new Set(bundle.summary.products);
  if (products.size > 1) return "release_gate";
  if (products.has("mcpbench")) return "mcpbench";
  if (products.has("tripwire-ci")) return "tripwire";
  if (products.has("onegent-runtime")) return "runtime";
  return "custom";
}

interface HostedTraceContext { traceId: string; rootSpanId: string }

function hostedTrace(projectId: string, externalId: string): HostedTraceContext {
  const traceId = createHash("sha256").update(`agentcert:${projectId}:${externalId}`).digest("hex").slice(0, 32);
  return { traceId, rootSpanId: stableSpanId(`${traceId}:root`) };
}

function buildHostedObservationEvents(bundle: AgentCertBundle, trace: HostedTraceContext): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [{
    sequence: 0,
    type: "agentcert.run.started",
    actor: "agentcert-cli",
    occurredAt: bundle.generatedAt,
    payload: redactedPayload({ subject: bundle.subject, products: bundle.summary.products, schemaVersion: bundle.schemaVersion }),
    traceId: trace.traceId,
    spanId: trace.rootSpanId,
  }];
  for (const [resultIndex, result] of bundle.results.entries()) {
    if (events.length >= 478) break;
    const resultSpanId = stableSpanId(`${trace.traceId}:result:${resultIndex}:${result.runId}`);
    events.push({
      sequence: events.length,
      type: "agentcert.product.result",
      actor: result.product,
      occurredAt: result.timestamp || bundle.generatedAt,
      payload: redactedPayload({ product: result.product, phase: result.phase, passed: result.passed, score: result.score, certLevel: result.certLevel, summary: result.summary, sourceRunId: result.runId }),
      traceId: trace.traceId,
      spanId: resultSpanId,
      parentSpanId: trace.rootSpanId,
    });
    for (const [findingIndex, finding] of result.evidence.entries()) {
      if (events.length >= 478) break;
      events.push({
        sequence: events.length,
        type: findingEventType(result.product, finding.kind),
        actor: result.product,
        occurredAt: result.timestamp || bundle.generatedAt,
        payload: redactedPayload({
          findingId: finding.id,
          kind: finding.kind,
          severity: finding.severity,
          message: finding.message,
          source: finding.source,
          artifactPath: finding.artifactPath,
          suggestedFix: finding.suggestedFix,
          metadata: finding.metadata,
          passed: !new Set(["critical", "high"]).has(finding.severity),
        }),
        traceId: trace.traceId,
        spanId: stableSpanId(`${trace.traceId}:finding:${resultIndex}:${findingIndex}:${finding.id}`),
        parentSpanId: resultSpanId,
      });
    }
  }
  events.push({
    sequence: events.length,
    type: "agentcert.run.evaluated",
    actor: "agentcert-cli",
    occurredAt: bundle.generatedAt,
    payload: redactedPayload({ verdict: bundle.verdict, summary: bundle.summary, evidenceStrength: bundle.evidenceStrength?.level }),
    traceId: trace.traceId,
    spanId: stableSpanId(`${trace.traceId}:evaluated`),
    parentSpanId: trace.rootSpanId,
  });
  return events;
}

function findingEventType(product: AgentCertBundle["results"][number]["product"], kind: string): string {
  if (product === "tripwire-ci") return "tripwire.fault.assertion";
  if (product === "mcpbench") return /policy|permission|security|violation/i.test(kind) ? "mcpbench.policy.violation" : "mcpbench.assertion";
  if (product === "onegent-runtime") {
    if (/approval/i.test(kind)) return "onegent.approval.decision";
    if (/outcome|verification/i.test(kind)) return "onegent.outcome.verification";
    if (/policy|mandate|authorization/i.test(kind)) return "onegent.policy.decision";
    return "onegent.action.observation";
  }
  return "agentcert.finding";
}

function stableSpanId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function redactedPayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}...[TRUNCATED]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactedPayload(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      result[key] = /(authorization|api.?key|token|secret|password|credential)/i.test(key) ? "[REDACTED]" : redactedPayload(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

function scopeFingerprint(scope: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function boolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function assuranceStatus(value: unknown): ContinuousAssuranceHealth["status"] {
  return value === "CURRENT" || value === "REVALIDATION_REQUIRED" || value === "SUSPENDED" || value === "EXPIRED" ? value : "UNKNOWN";
}
function evidenceCompletenessStatus(value: unknown): ContinuousAssuranceHealth["evidence"]["status"] {
  return value === "complete" || value === "partial" || value === "rejected" ? value : "unknown";
}
function assuranceTrigger(value: unknown): ContinuousAssuranceHealth["assurance"]["trigger"] {
  return value === "pull_request" || value === "release" || value === "nightly" ? value : undefined;
}
function diagnostic(code: string, message: string, recovery: string) { return { code, message, recovery }; }

async function requestJson<T extends Record<string, unknown>>(
  request: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlPlaneRequestError(`AgentCert control plane request failed: ${message}`);
  }
  const text = await response.text();
  let value: Record<string, unknown> = {};
  if (text) {
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!response.ok) throw new ControlPlaneRequestError(`AgentCert control plane returned HTTP ${response.status}.`, response.status);
      throw new ControlPlaneRequestError("AgentCert control plane returned invalid JSON.", response.status);
    }
  }
  if (!response.ok) {
    throw new ControlPlaneRequestError(
      [typeof value.error === "string" ? value.error : `AgentCert control plane returned HTTP ${response.status}.`,
        typeof value.recovery === "string" ? value.recovery : undefined,
        typeof value.requestId === "string" ? `Request ID: ${value.requestId}.` : undefined].filter(Boolean).join(" "),
      response.status,
      typeof value.code === "string" ? value.code : undefined,
      typeof value.requestId === "string" ? value.requestId : response.headers.get("x-request-id") ?? undefined,
      typeof value.recovery === "string" ? value.recovery : undefined,
    );
  }
  return value as T;
}
