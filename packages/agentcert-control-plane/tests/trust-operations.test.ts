import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { RedisFixedWindowRateLimiter, RedisIdempotencyCoordinator } from "../src/coordination.js";
import { WebhookSecretVault, createWebhookSignature } from "../src/security.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner, verifyEvidenceAttestation } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

describe("durable webhook delivery", () => {
  it("queues events, retries deterministically, and moves exhausted jobs to the dead-letter queue", async () => {
    const store = new InMemoryControlPlaneStore();
    const vault = new WebhookSecretVault(randomBytes(32).toString("base64url"));
    const requestFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], undefined, vault, requestFetch as typeof fetch);
    const projectId = (await service.bootstrap(user)).project.id;
    await service.createWebhook(user, projectId, { url: "https://hooks.example.test/agentcert", eventTypes: ["run.completed"] });
    const run = await service.startRun(user, projectId, { externalId: "retry-run", kind: "custom" });
    await service.completeRun(user, projectId, run.id, { status: "failed" });

    let [job] = await store.listWebhookJobs(projectId);
    expect(job).toMatchObject({ status: "pending", attemptCount: 0, maxAttempts: 5 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await service.processWebhookJobs("worker-a", new Date(job!.nextAttemptAt));
      [job] = await store.listWebhookJobs(projectId);
      expect(job!.attemptCount).toBe(attempt);
    }

    expect(job).toMatchObject({ status: "dead_letter", attemptCount: 5, lastResponseStatus: 503 });
    expect(requestFetch).toHaveBeenCalledTimes(5);
    expect(await store.listWebhookDeliveries(projectId)).toHaveLength(5);

    const retried = await service.retryWebhookJob(user, projectId, job!.id);
    expect(retried).toMatchObject({ status: "pending", attemptCount: 0, lastError: undefined });
  });

  it("recovers a processing job after its worker lease expires", async () => {
    const store = new InMemoryControlPlaneStore();
    const now = "2026-07-15T00:01:00.000Z";
    await store.enqueueWebhookJob({
      id: "00000000-0000-4000-8000-000000000010", projectId: "p1", webhookId: "w1", eventId: "e1", eventType: "run.completed",
      payload: {}, status: "processing", attemptCount: 0, maxAttempts: 5, nextAttemptAt: "2026-07-15T00:00:00.000Z",
      lockedAt: "2026-07-15T00:00:00.000Z", lockedBy: "dead-worker", createdAt: "2026-07-15T00:00:00.000Z",
    });
    const claimed = await store.claimWebhookJobs("worker-b", now, "2026-07-15T00:00:30.000Z", 10);
    expect(claimed).toMatchObject([{ status: "processing", lockedBy: "worker-b", lockedAt: now }]);
  });

  it("provides an idempotent self-test receiver that verifies signed delivery bytes", async () => {
    const store = new InMemoryControlPlaneStore();
    const vault = new WebhookSecretVault(randomBytes(32).toString("base64url"));
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], undefined, vault);
    const projectId = (await service.bootstrap(user)).project.id;
    const created = await service.createTestWebhook(user, projectId, "https://agentcert.example");
    expect(created.reused).toBe(false);
    if (created.reused) throw new Error("Expected a new self-test webhook.");
    const reused = await service.createTestWebhook(user, projectId, "https://agentcert.example");
    expect(reused).toMatchObject({ webhook: { id: created.webhook.id }, reused: true });

    const event = { id: "run-1", type: "run.completed", projectId, occurredAt: "2026-07-15T00:00:00.000Z", data: {} };
    const body = Buffer.from(JSON.stringify(event));
    const timestamp = String(Date.parse("2026-07-15T00:00:00.000Z") / 1000);
    const headers = {
      "x-agentcert-timestamp": timestamp,
      "x-agentcert-signature": createWebhookSignature(created.secret, timestamp, body.toString("utf8")),
      "x-agentcert-event": event.type,
      "x-agentcert-event-id": event.id,
    };
    await expect(service.acceptTestWebhook(projectId, created.webhook.id, headers, body, new Date("2026-07-15T00:00:01.000Z"))).resolves.toBeUndefined();
    await expect(service.acceptTestWebhook(projectId, created.webhook.id, { ...headers, "x-agentcert-signature": "v1=bad" }, body, new Date("2026-07-15T00:00:01.000Z")))
      .rejects.toMatchObject({ status: 401 });
  });
});

describe("signing key rotation", () => {
  it("retires the previous public key while preserving old signature verification", async () => {
    const store = new InMemoryControlPlaneStore();
    const firstPair = generateKeyPairSync("ed25519");
    const secondPair = generateKeyPairSync("ed25519");
    const first = new EvidenceSigner("key-2026-07", firstPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const second = new EvidenceSigner("key-2026-08", secondPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const payload = { evidenceId: "e1", projectId: "p1", kind: "trace", schemaVersion: "v1", sha256: "ab".repeat(32), sizeBytes: 2, createdAt: "2026-07-15T00:00:00.000Z" };
    const oldAttestation = first.attest(payload, "2026-07-15T00:00:01.000Z");

    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], first).activateSigningKey(new Date("2026-07-15T00:00:00.000Z"));
    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], first).activateSigningKey(new Date("2026-07-20T00:00:00.000Z"));
    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], second).activateSigningKey(new Date("2026-08-15T00:00:00.000Z"));
    const keys = await store.listSigningKeys();

    expect(keys).toMatchObject([
      { keyId: "key-2026-08", status: "active" },
      { keyId: "key-2026-07", status: "retired", activatedAt: "2026-07-15T00:00:00.000Z", retiredAt: "2026-08-15T00:00:00.000Z" },
    ]);
    expect(verifyEvidenceAttestation(payload, oldAttestation, keys[1]!.publicKeyPem)).toBe(true);
  });

  it("rejects reusing a key ID for different key material", async () => {
    const store = new InMemoryControlPlaneStore();
    const first = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const second = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], new EvidenceSigner("same-id", first)).activateSigningKey();
    await expect(new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], new EvidenceSigner("same-id", second)).activateSigningKey())
      .rejects.toThrow("already belongs to another public key");
  });
});

describe("Redis coordination primitives", () => {
  it("uses one atomic fixed-window operation", async () => {
    const evalMock = vi.fn(async () => [2, 800]);
    const limiter = new RedisFixedWindowRateLimiter({ eval: evalMock } as never, 3, 1_000);
    await expect(limiter.consume("principal:1", 1_000)).resolves.toMatchObject({ allowed: true, remaining: 1, resetAt: 1_800 });
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it("releases a distributed idempotency lock only with its owner token", async () => {
    const setMock = vi.fn(async () => "OK");
    const evalMock = vi.fn(async () => 1);
    const coordinator = new RedisIdempotencyCoordinator({ set: setMock, eval: evalMock } as never);
    await expect(coordinator.runExclusive("project:operation:key", async () => "done"))
      .resolves.toMatchObject({ acquired: true, value: "done" });
    expect(setMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), { NX: true, PX: 30_000 });
    expect(evalMock).toHaveBeenCalledOnce();
  });
});
