import { describe, expect, it, vi } from "vitest";
import { pushEvidenceToControlPlane, verifyControlPlaneConnection } from "../src/control-plane.js";
import type { AgentCertBundle } from "../src/types.js";

const bundle: AgentCertBundle = {
  schemaName: "agentcert.evidence_bundle",
  schemaVersion: "agentcert.evidence.v0.1",
  schemaSemver: "0.1.0",
  kind: "agentcert.evidence_bundle",
  runId: "tripwire-run-1",
  generatedAt: "2026-07-14T00:00:00.000Z",
  subject: { name: "browser-agent", type: "agent" },
  verdict: { passed: false, score: 0.6, level: "fail" },
  summary: { products: ["tripwire-ci"], criticalEvidence: 0, highEvidence: 1, totalEvidence: 1 },
  results: [],
  evidence: [{ id: "ev-1", kind: "wrong_click", severity: "high", message: "Clicked Cancel instead of Submit." }],
  artifacts: {},
  standards: [],
};

describe("hosted evidence push", () => {
  it("verifies a saved connection against the project overview", async () => {
    const request = vi.fn(async () => jsonResponse(200, {
      projectId: "project-1",
      summary: { runs: 2, evidence: 2 },
    }));

    await expect(verifyControlPlaneConnection({
      baseUrl: "https://agentcert.example.com/",
      projectId: "project-1",
      apiKey: "ac_live_secret",
      fetch: request as typeof fetch,
    })).resolves.toEqual({ projectId: "project-1", runs: 2, evidence: 2 });
    expect(request).toHaveBeenCalledWith(
      "https://agentcert.example.com/v1/projects/project-1/overview",
      expect.objectContaining({ headers: { authorization: "Bearer ac_live_secret" } }),
    );
  });

  it("explains whether credentials or project scope caused verification to fail", async () => {
    const unauthorized = vi.fn(async () => jsonResponse(401, { error: "Authentication required." }));
    await expect(verifyControlPlaneConnection({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-1",
      apiKey: "ac_live_bad",
      fetch: unauthorized as typeof fetch,
    })).rejects.toThrow("API key was rejected");

    const forbidden = vi.fn(async () => jsonResponse(403, { error: "API key is not scoped to this project." }));
    await expect(verifyControlPlaneConnection({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-2",
      apiKey: "ac_live_secret",
      fetch: forbidden as typeof fetch,
    })).rejects.toThrow("cannot access project project-2");
  });

  it("preserves hosted recovery guidance and request IDs in push failures", async () => {
    const request = vi.fn(async () => jsonResponse(403, {
      error: "API key is not scoped to this project.", code: "api_key_project_mismatch",
      recovery: "Create a key in the selected project.", requestId: "req-42",
    }));
    await expect(pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com", projectId: "wrong-project", apiKey: "ac_live_secret",
      bundle, evidenceBytes: new TextEncoder().encode("{}"), fetch: request as typeof fetch,
    })).rejects.toThrow("Create a key in the selected project. Request ID: req-42");
  });

  it("creates a run, records provenance, uploads the exact bytes, and completes visibly as failed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/runs")) return jsonResponse(201, { id: "hosted-run-1" });
      if (url.includes("/evidence?")) return jsonResponse(201, { id: "hosted-evidence-1" });
      return jsonResponse(200, {});
    });
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));

    const result = await pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com/",
      projectId: "project-1",
      apiKey: "ac_live_secret",
      bundle,
      evidenceBytes: bytes,
      fetch: request as typeof fetch,
    });

    expect(result).toEqual({
      runId: "hosted-run-1",
      evidenceId: "hosted-evidence-1",
      externalId: "tripwire-run-1",
      artifactsUploaded: 0,
      artifactsSkipped: 0,
      artifactBytesUploaded: 0,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://agentcert.example.com/v1/projects/project-1/runs",
      "https://agentcert.example.com/v1/projects/project-1/runs/hosted-run-1/events",
      expect.stringContaining("https://agentcert.example.com/v1/projects/project-1/evidence?"),
      "https://agentcert.example.com/v1/projects/project-1/runs/hosted-run-1/complete",
    ]);
    const uploadedBundle = JSON.parse(new TextDecoder().decode(new Uint8Array(calls[2].init?.body as ArrayBuffer)));
    expect(uploadedBundle).toMatchObject({
      runId: bundle.runId,
      artifactManifest: { schemaVersion: "agentcert.artifact_manifest.v0.1", entries: [] },
    });
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
      status: "failed",
      score: 0.6,
      firstDivergence: "Clicked Cancel instead of Submit.",
      metadata: { evidenceId: "hosted-evidence-1" },
    });
    expect(String((calls[0].init?.headers as Record<string, string>).authorization)).toBe("Bearer ac_live_secret");
  });

  it("passes the locked assurance case, trigger, and scope only on run creation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/runs")) return jsonResponse(201, { id: "hosted-run-1" });
      if (url.includes("/evidence?")) return jsonResponse(201, { id: "hosted-evidence-1" });
      return jsonResponse(200, {});
    });
    const scope = {
      schemaVersion: "agentcert.assurance_scope.v0.1",
      agent: { id: "browser-agent", version: "2.4.0" },
      model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
      prompt: { sha256: "a".repeat(64) }, tools: { manifestSha256: "b".repeat(64) },
      policy: { id: "agentcert.browser", version: "0.1.0" },
      scenarioSuite: { id: "tripwire", version: "2026.07", sha256: "c".repeat(64) },
    };
    await pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com", projectId: "project-1", apiKey: "ac_live_secret",
      bundle, evidenceBytes: new TextEncoder().encode("{}"),
      assurance: { caseId: "case-1", trigger: "nightly", scope }, fetch: request as typeof fetch,
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ assurance: { caseId: "case-1", trigger: "nightly", scope } });
    expect(JSON.parse(String(calls.at(-1)!.init?.body)).metadata).not.toHaveProperty("continuousAssurance");
  });

  it("uploads bounded companion bytes with source paths and records skipped artifacts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let evidenceCount = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/runs")) return jsonResponse(201, { id: "hosted-run-1" });
      if (url.includes("/evidence?")) return jsonResponse(201, { id: `hosted-evidence-${++evidenceCount}` });
      return jsonResponse(200, {});
    });
    const screenshot = new TextEncoder().encode("png-bytes");

    const result = await pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-1",
      apiKey: "ac_live_secret",
      bundle,
      evidenceBytes: new TextEncoder().encode("{}"),
      companionArtifacts: [{
        sourcePath: "screenshots/step-1.png",
        fileName: "step-1.png",
        kind: "screenshot",
        contentType: "image/png",
        bytes: screenshot,
      }],
      skippedCompanionArtifacts: [{ sourcePath: "../secret.txt", reason: "outside_artifact_root" }],
      fetch: request as typeof fetch,
    });

    expect(result).toMatchObject({ artifactsUploaded: 1, artifactsSkipped: 1, artifactBytesUploaded: screenshot.byteLength });
    const artifactUpload = calls.find((call) => call.url.includes("fileName=step-1.png"));
    expect(artifactUpload?.url).toContain("sourcePath=screenshots%2Fstep-1.png");
    expect(artifactUpload?.init?.headers).toMatchObject({ "content-type": "image/png" });
    expect(new Uint8Array(artifactUpload?.init?.body as ArrayBuffer)).toEqual(screenshot);
    const bundleUpload = calls.find((call) => call.url.includes("kind=evidence_bundle"));
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(bundleUpload?.init?.body as ArrayBuffer))).artifactManifest).toMatchObject({
      schemaVersion: "agentcert.artifact_manifest.v0.1",
      entries: [{ path: "screenshots/step-1.png", sizeBytes: screenshot.byteLength, kind: "screenshot" }],
    });
    const artifactEvent = calls.find((call) => String(call.init?.body).includes("agentcert.companion_artifacts.processed"));
    expect(JSON.parse(String(artifactEvent?.init?.body))).toMatchObject({
      events: [{
        sequence: 1,
        payload: {
          uploadedCount: 1,
          skippedCount: 1,
          skipped: [{ sourcePath: "../secret.txt", reason: "outside_artifact_root" }],
        },
      }],
    });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({
      metadata: { companionArtifactsUploaded: 1, companionArtifactsSkipped: 1 },
    });
  });

  it("does not complete the hosted run when a companion upload fails", async () => {
    const urls: string[] = [];
    let evidenceCount = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/runs")) return jsonResponse(201, { id: "hosted-run-1" });
      if (url.includes("/evidence?")) {
        evidenceCount += 1;
        return evidenceCount === 1 ? jsonResponse(201, { id: "bundle-1" }) : jsonResponse(500, { error: "Artifact storage failed." });
      }
      return jsonResponse(200, {});
    });

    await expect(pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-1",
      apiKey: "ac_live_secret",
      bundle,
      evidenceBytes: new TextEncoder().encode("{}"),
      companionArtifacts: [{
        sourcePath: "trace.json", fileName: "trace.json", kind: "trace",
        contentType: "application/json", bytes: new TextEncoder().encode("{}"),
      }],
      fetch: request as typeof fetch,
    })).rejects.toThrow("Artifact storage failed.");
    expect(urls.some((url) => url.endsWith("/complete"))).toBe(false);
  });

  it("preserves an existing manifest when companion collection is intentionally disabled", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/runs")) return jsonResponse(201, { id: "hosted-run-1" });
      if (url.includes("/evidence?")) return jsonResponse(201, { id: "hosted-evidence-1" });
      return jsonResponse(200, {});
    });
    const declared = {
      ...bundle,
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1" as const,
        entries: [{ path: "trace.json", sha256: "a".repeat(64), sizeBytes: 2, kind: "trace" }],
      },
    };
    await pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com", projectId: "project-1", apiKey: "ac_live_secret",
      bundle: declared, evidenceBytes: new TextEncoder().encode(JSON.stringify(declared)), fetch: request as typeof fetch,
    });
    const upload = calls.find((call) => call.url.includes("kind=evidence_bundle"));
    const uploaded = JSON.parse(new TextDecoder().decode(new Uint8Array(upload?.init?.body as ArrayBuffer)));
    expect(uploaded.artifactManifest).toEqual(declared.artifactManifest);
  });

  it("surfaces API errors without returning a partial success", async () => {
    const request = vi.fn(async () => jsonResponse(401, { error: "API key is invalid." }));
    await expect(pushEvidenceToControlPlane({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-1",
      apiKey: "bad-key",
      bundle,
      evidenceBytes: new Uint8Array(),
      fetch: request as typeof fetch,
    })).rejects.toThrow("API key is invalid.");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
