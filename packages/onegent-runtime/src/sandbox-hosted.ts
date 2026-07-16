import { createHash } from "node:crypto";
import type { SandboxAdapterConformanceReport } from "./sandbox-adapter-kit.js";
import type { SandboxCertificationReport } from "./sandbox-harness.js";
import type { StripeSandboxReadOnlyReport } from "./stripe-test-readonly.js";

export const SANDBOX_EVIDENCE_BUNDLE_SCHEMA_VERSION = "agentcert.evidence.v0.1" as const;

export type HostedSandboxReport = SandboxCertificationReport | SandboxAdapterConformanceReport | StripeSandboxReadOnlyReport;

export interface SandboxHostedUploadOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  externalId?: string;
  fetch?: typeof fetch;
}

export interface SandboxHostedUploadResult {
  run: Record<string, unknown>;
  evidence: Record<string, unknown>;
  completion: Record<string, unknown>;
}

export interface SandboxCertificationEvidenceBundle {
  schemaName: "agentcert.evidence_bundle";
  schemaVersion: typeof SANDBOX_EVIDENCE_BUNDLE_SCHEMA_VERSION;
  schemaSemver: "0.1.0";
  kind: "agentcert.evidence_bundle";
  runId: string;
  generatedAt: string;
  subject: {
    name: string;
    type: "application";
  };
  verdict: {
    passed: boolean;
    score: number;
    level: string;
  };
  summary: {
    products: ["onegent-runtime"];
    criticalEvidence: number;
    highEvidence: number;
    totalEvidence: 1;
  };
  results: Array<{
    schemaVersion: "1";
    product: "onegent-runtime";
    runId: string;
    timestamp: string;
    phase: "pre-release";
    score: number;
    passed: boolean;
    summary: string;
    artifacts: Record<string, string>;
    evidence: Array<{
      id: string;
      kind: "sandbox_adapter_conformance" | "sandbox_certification" | "sandbox_vendor_egress";
      severity: "info" | "high";
      message: string;
      source: "onegent-runtime";
      metadata: { report: HostedSandboxReport; reportSchemaVersion: string };
    }>;
  }>;
  evidence: SandboxCertificationEvidenceBundle["results"][number]["evidence"];
  artifacts: Record<string, string>;
  artifactManifest: {
    schemaVersion: "agentcert.artifact_manifest.v0.1";
    entries: [];
  };
  standards: Array<{
    id: "agentcert-sandbox-contract";
    name: "AgentCert Sandbox Adapter Contract";
    status: "mapped";
    note: string;
  }>;
}

export function createSandboxCertificationEvidenceBundle(
  report: HostedSandboxReport,
): SandboxCertificationEvidenceBundle {
  const reportDigest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const runId = `sandbox-${reportDigest}`;
  const evidence: SandboxCertificationEvidenceBundle["evidence"] = [{
    id: `${report.kind}:${reportDigest.slice(0, 16)}`,
    kind: report.kind === "agentcert.sandbox_adapter_conformance"
      ? "sandbox_adapter_conformance"
      : report.kind === "agentcert.sandbox_vendor_egress"
        ? "sandbox_vendor_egress"
        : "sandbox_certification",
    severity: report.verdict.passed ? "info" : "high",
    message: `${report.kind} ${report.verdict.passed ? "passed" : "failed"} (${report.verdict.score}/100).`,
    source: "onegent-runtime",
    metadata: { report: structuredClone(report), reportSchemaVersion: report.schemaVersion },
  }];
  return {
    schemaName: "agentcert.evidence_bundle",
    schemaVersion: SANDBOX_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    schemaSemver: "0.1.0",
    kind: "agentcert.evidence_bundle",
    runId,
    generatedAt: report.generatedAt,
    subject: { name: report.implementation, type: "application" },
    verdict: {
      passed: report.verdict.passed,
      score: report.verdict.score,
      level: report.verdict.passed ? "Sandbox conformant" : "Not conformant",
    },
    summary: {
      products: ["onegent-runtime"],
      criticalEvidence: 0,
      highEvidence: report.verdict.passed ? 0 : 1,
      totalEvidence: 1,
    },
    results: [{
      schemaVersion: "1",
      product: "onegent-runtime",
      runId,
      timestamp: report.generatedAt,
      phase: "pre-release",
      score: report.verdict.score,
      passed: report.verdict.passed,
      summary: `${report.kind} ${report.verdict.passed ? "passed" : "failed"}.`,
      artifacts: {},
      evidence,
    }],
    evidence,
    artifacts: {},
    artifactManifest: { schemaVersion: "agentcert.artifact_manifest.v0.1", entries: [] },
    standards: [{
      id: "agentcert-sandbox-contract",
      name: "AgentCert Sandbox Adapter Contract",
      status: "mapped",
      note: "Synthetic or vendor test-mode evidence only. This does not authorize production access or certify production-side controls.",
    }],
  };
}

export async function uploadSandboxCertificationReport(
  report: HostedSandboxReport,
  options: SandboxHostedUploadOptions,
): Promise<SandboxHostedUploadResult> {
  const baseUrl = required(options.baseUrl, "baseUrl").replace(/\/$/, "");
  const projectId = required(options.projectId, "projectId");
  const apiKey = required(options.apiKey, "apiKey");
  const requestFetch = options.fetch ?? fetch;
  const projectUrl = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}`;
  const bundle = createSandboxCertificationEvidenceBundle(report);
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const operationId = `sandbox-upload-${digest.slice(0, 32)}`;
  const externalId = options.externalId?.trim() || `${report.kind}:${report.implementation}:${report.generatedAt}`;

  const run = await jsonRequest(requestFetch, `${projectUrl}/runs`, apiKey, {
    method: "POST",
    headers: { "idempotency-key": `${operationId}:run` },
    body: JSON.stringify({
      externalId,
      kind: "custom",
      schemaVersion: report.schemaVersion,
      startedAt: report.generatedAt,
      metadata: {
        productLine: "onegent-runtime",
        evidenceType: report.kind,
        implementation: report.implementation,
        sandboxOnly: true,
      },
    }),
  });
  if (typeof run.id !== "string" || !run.id) throw new Error("AgentCert Control Plane returned a run without an id.");

  const query = new URLSearchParams({
    fileName: "sandbox-certification-evidence.json",
    kind: "evidence_bundle",
    schemaVersion: SANDBOX_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    runId: run.id,
  });
  const evidence = await jsonRequest(requestFetch, `${projectUrl}/evidence?${query}`, apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(bytes).buffer as ArrayBuffer,
  });

  const completion = await jsonRequest(requestFetch, `${projectUrl}/runs/${encodeURIComponent(run.id)}/complete`, apiKey, {
    method: "POST",
    headers: { "idempotency-key": `${operationId}:complete` },
    body: JSON.stringify({
      status: report.verdict.passed ? "passed" : "failed",
      score: report.verdict.score / 100,
      summary: `${report.kind} ${report.verdict.passed ? "passed" : "failed"} (${report.verdict.score}/100).`,
      metadata: {
        evidenceId: evidence.id,
        evidenceSha256: evidence.sha256,
        sandboxReportSchemaVersion: report.schemaVersion,
      },
    }),
  });
  return { run, evidence, completion };
}

async function jsonRequest(
  requestFetch: typeof fetch,
  url: string,
  apiKey: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await requestFetch(url, { ...init, headers, redirect: "error" });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof value.error === "string" ? value.error : `AgentCert Control Plane request failed (${response.status}).`);
  }
  return value;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Sandbox hosted upload ${name} is required.`);
  return normalized;
}
