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
  fetch?: typeof fetch;
}

export interface PushEvidenceResult {
  runId: string;
  evidenceId: string;
  externalId: string;
  artifactsUploaded: number;
  artifactsSkipped: number;
  artifactBytesUploaded: number;
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

  const run = await requestJson<{ id: string }>(request, `${projectUrl}/runs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      externalId,
      kind,
      schemaVersion: bundle.schemaVersion,
      startedAt: bundle.generatedAt,
      metadata: {
        subject: bundle.subject,
        products: bundle.summary.products,
      },
    }),
  });

  await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        sequence: 0,
        type: "agentcert.evidence.created",
        actor: "agentcert-cli",
        occurredAt: bundle.generatedAt,
        payload: {
          verdict: bundle.verdict,
          totalEvidence: bundle.summary.totalEvidence,
          criticalEvidence: bundle.summary.criticalEvidence,
          highEvidence: bundle.summary.highEvidence,
        },
      }],
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

  if (companionArtifacts.length > 0 || skippedArtifacts.length > 0) {
    await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/events`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          sequence: 1,
          type: "agentcert.companion_artifacts.processed",
          actor: "agentcert-cli",
          occurredAt: bundle.generatedAt,
          payload: {
            uploadedCount: companionArtifacts.length,
            skippedCount: skippedArtifacts.length,
            uploadedBytes: artifactBytesUploaded,
            skipped: skippedArtifacts
              .slice(0, MAX_REPORTED_COMPANION_ARTIFACT_SKIPS)
              .map(({ sourcePath, reason }) => ({ sourcePath, reason })),
            skippedDetailsTruncated: skippedArtifacts.length > MAX_REPORTED_COMPANION_ARTIFACT_SKIPS,
          },
        }],
      }),
    });
  }

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

  return {
    runId: run.id,
    evidenceId: evidence.id,
    externalId,
    artifactsUploaded: companionArtifacts.length,
    artifactsSkipped: skippedArtifacts.length,
    artifactBytesUploaded,
  };
}

function hostedRunKind(bundle: AgentCertBundle): "mcpbench" | "tripwire" | "release_gate" | "runtime" | "custom" {
  const products = new Set(bundle.summary.products);
  if (products.size > 1) return "release_gate";
  if (products.has("mcpbench")) return "mcpbench";
  if (products.has("tripwire-ci")) return "tripwire";
  if (products.has("onegent-runtime")) return "runtime";
  return "custom";
}

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
