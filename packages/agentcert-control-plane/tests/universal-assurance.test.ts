import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { createTraceContext, parseUniversalEnvelope } from "../src/protocol.js";
import { FixedWindowRateLimiter, WebhookSecretVault, createWebhookSignature } from "../src/security.js";
import { EvidenceSigner, canonicalJson, verifyEvidenceAttestation } from "../src/signing.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { CONTROL_PLANE_MIGRATIONS, InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext, EvidenceRecord } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

describe("control-plane migrations", () => {
  it("loads the latest production migration during startup", () => {
    expect(CONTROL_PLANE_MIGRATIONS.at(-1)).toBe("019_continuous_assurance_adoption.sql");
  });
});

describe("Universal Event/Action Envelope v0.1", () => {
  it("validates W3C-compatible trace IDs and ingests events into a stable run", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const trace = createTraceContext();
    const input = {
      schemaVersion: "agentcert.envelope.v0.1",
      envelopeId: "evt-1",
      kind: "event",
      occurredAt: "2026-07-15T12:00:00.000Z",
      source: { agentId: "research-agent", agentVersion: "1.2.0", framework: "langgraph", adapter: "agentcert-langgraph" },
      run: { externalId: "research-run-1", kind: "custom" },
      trace,
      event: { sequence: 0, type: "tool.started", attributes: { tool: "search" } },
    };
    expect(parseUniversalEnvelope(input).trace.traceId).toMatch(/^[0-9a-f]{32}$/);

    const result = await service.ingestEnvelope({ kind: "api_key", projectId, scopes: ["runs:write", "events:write"] }, projectId, input);
    expect(result.run).toMatchObject({ externalId: "research-run-1", traceId: trace.traceId });
    expect(result.event).toMatchObject({ type: "tool.started", traceId: trace.traceId, spanId: trace.spanId });
  });

  it("routes action envelopes through the existing risk and approval policy", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const result = await service.ingestEnvelope({ kind: "api_key", projectId, scopes: ["runs:write", "actions:write"] }, projectId, {
      schemaVersion: "agentcert.envelope.v0.1", envelopeId: "action-envelope-1", kind: "action",
      occurredAt: "2026-07-15T12:00:00.000Z", source: { agentId: "procurement-agent", framework: "openai-agents" },
      run: { externalId: "runtime-run-1", kind: "runtime" }, trace: createTraceContext(),
      action: { externalId: "po-4850", principal: { id: "procurement-agent" }, actionType: "SUBMIT", targetSystem: "MockERP",
        requestedPermissions: [], amount: 4850, currency: "USD", expectedState: { status: "SUBMITTED" },
        assurance: { mandateId: "mandate-po-4850", mandateDigestSha256: "a".repeat(64), sourceReceiptSha256: "b".repeat(64), sourceKeyId: "customer-key-v1", evidenceStrength: "outcome_verified" } },
    });
    expect(result.action).toMatchObject({
      riskLevel: "HIGH", decision: "REQUIRE_APPROVAL", status: "PENDING_APPROVAL",
      assuranceContext: { mandateId: "mandate-po-4850", evidenceStrength: "outcome_verified" },
    });
  });
});

describe("control-plane security primitives", () => {
  it("canonicalizes JSON and verifies Ed25519 evidence attestations", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 1 }, omitted: undefined })).toBe('{"a":{"x":1,"y":2},"z":1}');
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new EvidenceSigner("test-key", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const payload = { evidenceId: "e-1", projectId: "p-1", kind: "trace", schemaVersion: "v1", sha256: "ab".repeat(32), sizeBytes: 12, createdAt: "2026-07-15T00:00:00.000Z" };
    const attestation = signer.attest(payload, "2026-07-15T00:00:01.000Z");
    expect(verifyEvidenceAttestation(payload, attestation, signer.publicKeyPem)).toBe(true);
    expect(verifyEvidenceAttestation({ ...payload, sizeBytes: 13 }, attestation, signer.publicKeyPem)).toBe(false);
  });

  it("enforces deterministic fixed-window rate limits", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.consume("key", 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("key", 1)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("key", 2)).toMatchObject({ allowed: false, remaining: 0 });
    expect(limiter.consume("key", 1_001)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("encrypts webhook secrets and produces stable HMAC signatures", () => {
    const vault = new WebhookSecretVault(randomBytes(32).toString("base64url"));
    const ciphertext = vault.encrypt("whsec_example");
    expect(ciphertext).not.toContain("whsec_example");
    expect(vault.decrypt(ciphertext)).toBe("whsec_example");
    expect(createWebhookSignature("secret", "100", "{}"))
      .toBe(createWebhookSignature("secret", "100", "{}"));
  });
});

describe("scoped integrations and governance reporting", () => {
  it("rejects API keys without the required scope", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const auth: AuthContext = { kind: "api_key", projectId, scopes: ["runs:read"] };
    await expect(service.startRun(auth, projectId, { externalId: "forbidden", kind: "custom" }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
  });

  it("signs evidence, records retention deletion, and reports continuous taxonomy quality", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new EvidenceSigner("server-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const store = new InMemoryControlPlaneStore();
    const artifacts = new MemoryArtifactStore();
    const service = new AgentCertControlPlane(store, artifacts, { projectLimitBytes: 1_000_000, runLimitBytes: 1_000_000, retentionDays: 90 }, [], signer);
    const projectId = (await service.bootstrap(user)).project.id;
    const run = await service.startRun(user, projectId, { externalId: "failed-run", kind: "tripwire" });
    await service.completeRun(user, projectId, run.id, { status: "failed" });
    await service.reviewFailure(user, projectId, run.id, {
      patternKey: "fault-1", suggestedType: "timeout", type: "network_failure", status: "corrected", confidence: 0.9,
      evidenceContext: {}, taxonomyRationale: { primaryReason: "The request failed before the agent timeout.", supportingSignals: ["HTTP 503"] },
    });
    const signed = await service.uploadEvidence(user, projectId, Buffer.from("{}"), {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    });
    expect(signed.metadata.serverAttestation).toMatchObject({ algorithm: "Ed25519", keyId: "server-test" });

    const old: EvidenceRecord = { ...signed, id: "00000000-0000-4000-8000-000000000099", objectKey: `${projectId}/old`, createdAt: "2025-01-01T00:00:00.000Z", sha256: "cd".repeat(32) };
    await artifacts.put(old.objectKey, Buffer.from("{}"), "application/json");
    await store.insertEvidence(old);
    expect((await service.cleanupExpiredEvidence(new Date("2026-07-15T00:00:00.000Z"))).deleted).toBe(1);
    const report = await service.legalHoldReport(user, projectId);
    expect(report.deletionJournal[0]).toMatchObject({ evidenceId: old.id, outcome: "deleted" });
    const overview = await service.overview(user, projectId);
    expect(overview.summary.taxonomyQuality).toMatchObject({ reviewCoverage: 1, autoLabelPrecision: 0, correctionRate: 1 });
  });

  it("signs and records webhook deliveries", async () => {
    const store = new InMemoryControlPlaneStore();
    const vault = new WebhookSecretVault(randomBytes(32).toString("base64url"));
    const requestFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], undefined, vault, requestFetch as typeof fetch);
    const projectId = (await service.bootstrap(user)).project.id;
    await expect(service.createWebhook(user, projectId, { url: "https://127.0.0.1/hook", eventTypes: ["run.completed"] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 400 });
    const created = await service.createWebhook(user, projectId, { url: "https://hooks.example.test/agentcert", eventTypes: ["run.completed"] });
    expect(created.secret).toMatch(/^whsec_/);
    const run = await service.startRun(user, projectId, { externalId: "webhook-run", kind: "custom" });
    await service.completeRun(user, projectId, run.id, { status: "passed" });
    await service.processWebhookJobs("test-worker");
    const { deliveries } = await service.listWebhooks(user, projectId);
    expect(deliveries).toMatchObject([{ eventType: "run.completed", status: "delivered" }]);
    const headers = requestFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-agentcert-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
