import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentCertClient, AgentCertRunRecorder, canonicalJson, createEventEnvelope, verifyServerAttestation } from "../src/index.js";

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

  it("binds a run to one declared continuous assurance scope", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 201 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    const scope = {
      schemaVersion: "agentcert.assurance_scope.v0.1" as const,
      agent: { id: "browser-agent", version: "2.4.0", artifactSha256: "a".repeat(64) },
      model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
      prompt: { sha256: "b".repeat(64) },
      tools: { manifestSha256: "c".repeat(64) },
      policy: { id: "agentcert.browser", version: "0.1.0", sha256: "d".repeat(64) },
      scenarioSuite: { id: "tripwire", version: "2026.07", sha256: "e".repeat(64) },
    };
    await client.startRun({
      externalId: "release-2.4.0", kind: "release_gate",
      assurance: { caseId: "case-1", trigger: "release", scope },
    });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toMatchObject({
      assurance: { caseId: "case-1", trigger: "release", scope },
    });
  });

  it("surfaces API errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: "Project access denied." }), { status: 403 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "bad", fetch: request as typeof fetch });
    await expect(client.getAction("action-1")).rejects.toThrow("Project access denied.");
  });

  it("uses the action assurance mandate and receipt endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/mandates")) {
        return new Response(JSON.stringify({ id: "mandate-1", digestSha256: "a".repeat(64), status: "active" }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: "receipt-1", actionId: "action-1", currentStatus: "valid" }), { status: 201 });
    });
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });

    await client.createMandate({
      granteeIdentityId: "procurement-agent",
      audience: ["mock-erp"],
      permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["purchase_order.submit"],
      permittedResources: ["purchase-order:PO-1001"],
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    await client.issueActionReceipt("action-1");

    expect(requests.map((item) => item.url)).toEqual([
      "https://agentcert.example/v1/projects/project-1/mandates",
      "https://agentcert.example/v1/projects/project-1/actions/action-1/receipt",
    ]);
    expect(JSON.parse(String(requests[0]!.init!.body))).toMatchObject({
      granteeIdentityId: "procurement-agent",
      permittedActionClasses: ["SUBMIT"],
    });
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

  it("records one ordered, trace-linked run without framework dependencies", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/runs")) return new Response(JSON.stringify({ id: "run-observe-1", status: "running" }), { status: 201 });
      if (String(url).endsWith("/complete")) return new Response(JSON.stringify({ id: "run-observe-1", status: "passed" }), { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 201 });
    });
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    const recorder = await AgentCertRunRecorder.start(client, { externalId: "release-1", kind: "release_gate" }, { batchSize: 2, actor: "browser-agent" });
    const child = recorder.childTrace();
    await recorder.recordEvent({ type: "tripwire.fault.assertion", payload: { fault: "modal", passed: true }, trace: child });
    await recorder.complete({ status: "passed", score: 100 });

    const startBody = JSON.parse(String(requests[0]!.init!.body));
    expect(startBody.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(startBody.rootSpanId).toMatch(/^[0-9a-f]{16}$/);
    const eventBodies = requests.filter((item) => item.url.includes("/events")).flatMap((item) => JSON.parse(String(item.init!.body)).events);
    expect(eventBodies.map((event: { sequence: number }) => event.sequence)).toEqual([0, 1, 2]);
    expect(eventBodies[1]).toMatchObject({
      type: "tripwire.fault.assertion", actor: "browser-agent",
      traceId: startBody.traceId, parentSpanId: startBody.rootSpanId,
    });
    const eventRequests = requests.filter((item) => item.url.includes("/events"));
    expect(eventRequests.map((item) => new Headers(item.init!.headers).get("idempotency-key"))).toEqual([
      "events-0-1",
      "events-2-2",
    ]);
  });

  it("reuses the event batch idempotency key after a lost response", async () => {
    const attempts: string[] = [];
    let failFirstBatch = true;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs")) return new Response(JSON.stringify({ id: "run-retry-1", status: "running" }), { status: 201 });
      if (String(url).includes("/events")) {
        attempts.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (failFirstBatch) {
          failFirstBatch = false;
          throw new Error("connection closed after commit");
        }
        return new Response(JSON.stringify({ events: [] }), { status: 202 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    const recorder = await AgentCertRunRecorder.start(client, { externalId: "retry-1", kind: "custom" }, { batchSize: 2 });

    await expect(recorder.recordEvent({ type: "step.completed" })).rejects.toThrow("connection closed after commit");
    await recorder.flush();

    expect(attempts).toEqual(["events-0-1", "events-0-1"]);
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
