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

    expect(result).toEqual({ runId: "hosted-run-1", evidenceId: "hosted-evidence-1", externalId: "tripwire-run-1" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://agentcert.example.com/v1/projects/project-1/runs",
      "https://agentcert.example.com/v1/projects/project-1/runs/hosted-run-1/events",
      expect.stringContaining("https://agentcert.example.com/v1/projects/project-1/evidence?"),
      "https://agentcert.example.com/v1/projects/project-1/runs/hosted-run-1/complete",
    ]);
    expect(new Uint8Array(calls[2].init?.body as ArrayBuffer)).toEqual(bytes);
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
      status: "failed",
      score: 0.6,
      firstDivergence: "Clicked Cancel instead of Submit.",
      metadata: { evidenceId: "hosted-evidence-1" },
    });
    expect(String((calls[0].init?.headers as Record<string, string>).authorization)).toBe("Bearer ac_live_secret");
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
