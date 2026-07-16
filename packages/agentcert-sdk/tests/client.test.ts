import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentCertClient, canonicalJson, createEventEnvelope, verifyServerAttestation } from "../src/index.js";

describe("AgentCertClient", () => {
  it("uses project-scoped authenticated endpoints", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example/", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });

    const result = await client.startRun({ externalId: "ci-1", kind: "tripwire" });

    expect(result.id).toBe("run-1");
    expect(request).toHaveBeenCalledWith(
      "https://agentcert.example/v1/projects/project-1/runs",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer ac_live_test" }) }),
    );
  });

  it("surfaces API errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: "Project access denied." }), { status: 403 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "bad", fetch: request as typeof fetch });
    await expect(client.getAction("action-1")).rejects.toThrow("Project access denied.");
  });

  it("sends the manifest source path for companion evidence reconciliation", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "evidence-1" }), { status: 201 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    await client.uploadEvidence({
      bytes: Buffer.from("{}"), fileName: "trace.json", contentType: "application/json", kind: "trace",
      runId: "run-1", sourcePath: "traces/trace.json",
    });
    expect(String(request.mock.calls[0]?.[0])).toContain("sourcePath=traces%2Ftrace.json");
  });

  it("sends universal envelopes with an idempotency key and valid trace context", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    const envelope = createEventEnvelope({
      envelopeId: "envelope-1", source: { agentId: "browser-agent", framework: "browser-use" },
      run: { externalId: "run-1", kind: "custom" }, event: { sequence: 0, type: "step.started" },
    });
    await client.sendEnvelope(envelope);
    expect(envelope.trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/envelopes"), expect.objectContaining({
      headers: expect.objectContaining({ "idempotency-key": "envelope-1" }),
    }));
  });

  it("verifies the server-signed canonical evidence chain", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = { evidenceId: "e-1", projectId: "p-1", kind: "trace", schemaVersion: "v1", sha256: "ab".repeat(32), sizeBytes: 2, createdAt: "2026-07-15T00:00:00.000Z" };
    const bytes = Buffer.from(canonicalJson(payload));
    const attestation = {
      schemaVersion: "agentcert.server_attestation.v0.1" as const, algorithm: "Ed25519" as const, keyId: "server-1",
      signedAt: "2026-07-15T00:00:01.000Z", payloadSha256: createHash("sha256").update(bytes).digest("hex"),
      signature: sign(null, bytes, privateKey).toString("base64url"),
    };
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyServerAttestation(payload, attestation, pem)).toBe(true);
    expect(verifyServerAttestation({ ...payload, sizeBytes: 3 }, attestation, pem)).toBe(false);
  });

  it("resolves historical public keys by attestation key ID", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = { evidenceId: "e-old", projectId: "p-1", kind: "trace", schemaVersion: "v1", sha256: "cd".repeat(32), sizeBytes: 4, createdAt: "2026-06-15T00:00:00.000Z" };
    const bytes = Buffer.from(canonicalJson(payload));
    const attestation = {
      schemaVersion: "agentcert.server_attestation.v0.1" as const, algorithm: "Ed25519" as const, keyId: "retired-key",
      signedAt: "2026-06-15T00:00:01.000Z", payloadSha256: createHash("sha256").update(bytes).digest("hex"),
      signature: sign(null, bytes, privateKey).toString("base64url"),
    };
    const request = vi.fn(async () => new Response(JSON.stringify({
      keyId: "retired-key", algorithm: "Ed25519", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "retired", activatedAt: "2026-06-01T00:00:00.000Z", retiredAt: "2026-07-01T00:00:00.000Z",
    }), { status: 200 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });

    await expect(client.verifyEvidenceAttestation(payload, attestation)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("https://agentcert.example/v1/signing-keys/retired-key");
  });
});
