import type { AgentCertBundle } from "./types.js";

export interface PushEvidenceOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  bundle: AgentCertBundle;
  evidenceBytes: Uint8Array;
  fileName?: string;
  externalId?: string;
  fetch?: typeof fetch;
}

export interface PushEvidenceResult {
  runId: string;
  evidenceId: string;
  externalId: string;
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
  constructor(message: string, readonly status?: number) {
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
  const externalId = options.externalId ?? options.bundle.runId;
  const kind = hostedRunKind(options.bundle);
  const headers = { authorization: `Bearer ${options.apiKey}` };

  const run = await requestJson<{ id: string }>(request, `${projectUrl}/runs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      externalId,
      kind,
      schemaVersion: options.bundle.schemaVersion,
      startedAt: options.bundle.generatedAt,
      metadata: {
        subject: options.bundle.subject,
        products: options.bundle.summary.products,
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
        occurredAt: options.bundle.generatedAt,
        payload: {
          verdict: options.bundle.verdict,
          totalEvidence: options.bundle.summary.totalEvidence,
          criticalEvidence: options.bundle.summary.criticalEvidence,
          highEvidence: options.bundle.summary.highEvidence,
        },
      }],
    }),
  });

  const query = new URLSearchParams({
    fileName: options.fileName ?? "agentcert-evidence.json",
    kind: "evidence_bundle",
    schemaVersion: options.bundle.schemaVersion,
    runId: run.id,
  });
  const evidence = await requestJson<{ id: string }>(request, `${projectUrl}/evidence?${query}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: new Uint8Array(options.evidenceBytes).buffer as ArrayBuffer,
  });

  const firstDivergence = options.bundle.evidence.find((item) => item.severity === "critical" || item.severity === "high")?.message;
  await requestJson(request, `${projectUrl}/runs/${encodeURIComponent(run.id)}/complete`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      status: options.bundle.verdict.passed ? "passed" : "failed",
      score: options.bundle.verdict.score,
      summary: `${options.bundle.subject.name}: ${options.bundle.verdict.level}`,
      firstDivergence,
      completedAt: options.bundle.generatedAt,
      metadata: {
        evidenceId: evidence.id,
        evidenceSchemaVersion: options.bundle.schemaVersion,
      },
    }),
  });

  return { runId: run.id, evidenceId: evidence.id, externalId };
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
      typeof value.error === "string" ? value.error : `AgentCert control plane returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return value as T;
}
