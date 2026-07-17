import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import {
  RedisFixedWindowRateLimiter,
  RedisIdempotencyCoordinator,
  createRedisCoordination,
} from "../src/coordination.js";
import { WebhookSecretVault, createWebhookSignature } from "../src/security.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner, verifyEvidenceAttestation } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";
import type { EmailMessage, EmailProvider } from "../src/notifications.js";

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

describe("Trust Operations v0.5", () => {
  it("persists smoke health and reports deterministic health and webhook trends", async () => {
    const store = new InMemoryControlPlaneStore();
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], new EvidenceSigner("key-current", privateKey),
    );
    const projectId = (await service.bootstrap(user)).project.id;
    await service.activateSigningKey(new Date("2026-07-14T00:00:00.000Z"));
    await service.recordTrustHealthSample(user, projectId, {
      externalId: "smoke-failed", source: "production_smoke", status: "failed",
      startedAt: "2026-07-14T08:00:00.000Z", completedAt: "2026-07-14T08:00:05.000Z", checks: ["health"], error: "temporary failure",
    });
    await service.recordTrustHealthSample(user, projectId, {
      externalId: "smoke-passed", source: "production_smoke", status: "passed",
      startedAt: "2026-07-15T07:59:58.000Z", completedAt: "2026-07-15T08:00:00.000Z", checks: ["health", "signature-chain"],
    });
    await service.recordTrustHealthSample(user, projectId, {
      externalId: "smoke-passed-2", source: "production_smoke", status: "passed",
      startedAt: "2026-07-15T08:09:58.000Z", completedAt: "2026-07-15T08:10:00.000Z", checks: ["health", "signature-chain"],
    });
    await store.enqueueWebhookJob({
      id: "00000000-0000-4000-8000-000000000010", projectId, webhookId: "webhook-1", eventId: "run-1", eventType: "run.completed",
      payload: {}, status: "delivered", attemptCount: 2, maxAttempts: 5, nextAttemptAt: "2026-07-15T07:00:00.000Z",
      createdAt: "2026-07-15T07:00:00.000Z", completedAt: "2026-07-15T07:00:02.000Z",
    });

    const operations = await service.operationsOverview(
      user, projectId, { backend: "redis", state: "ready", shared: true }, new Date("2026-07-15T08:30:00.000Z"),
    );
    expect(operations).toMatchObject({
      schemaVersion: "agentcert.trust_operations.v0.5", status: "warning",
      alerts: {
        redis: { status: "healthy" }, signing: { status: "healthy" },
        scheduledSmoke: { status: "healthy" }, webhooks: { status: "healthy" },
      },
      smoke: { latest: { externalId: "smoke-passed-2", status: "passed" } },
      incidents: { active: { status: "recovered", occurrenceCount: 1, consecutivePasses: 2 } },
      slo: { windows: [{ days: 30, total: 3, passed: 2, failed: 1 }, { days: 90, total: 3, passed: 2, failed: 1 }] },
      trends: { summary: { smokeSuccessRate: 2 / 3, webhookSuccessRate: 1, retryRate: 1, averageLatencyMs: 2000 } },
    });
    expect(operations.trends.health.at(-1)).toMatchObject({ date: "2026-07-15", total: 2, passed: 2, successRate: 1 });
  });

  it("raises actionable alerts for missing coordination, signing, and scheduled smoke", async () => {
    const service = new AgentCertControlPlane(new InMemoryControlPlaneStore(), new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const operations = await service.operationsOverview(user, projectId, undefined, new Date("2026-07-15T08:30:00.000Z"));
    expect(operations.status).toBe("critical");
    expect(operations.alerts).toMatchObject({
      redis: { status: "critical" }, signing: { status: "critical" }, scheduledSmoke: { status: "warning" },
    });
  });

  it("requires acknowledgement, two consecutive passes, and human resolution", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const sample = (externalId: string, status: "passed" | "failed", minute: number) => ({
      externalId, source: "production_smoke", status,
      startedAt: `2026-07-15T09:${String(minute).padStart(2, "0")}:00.000Z`,
      completedAt: `2026-07-15T09:${String(minute).padStart(2, "0")}:05.000Z`,
      checks: ["health"], ...(status === "failed" ? { error: "shared coordination unavailable" } : {}),
    });

    const failed = await service.recordTrustHealthSample(user, projectId, sample("failure-1", "failed", 0));
    expect(failed.operationalIncident).toMatchObject({ status: "open", occurrenceCount: 1, consecutivePasses: 0 });
    const incidentId = failed.operationalIncident!.id;
    await expect(service.acknowledgeOperationalIncident(user, projectId, incidentId, { reason: "short" })).rejects.toThrow("at least 10");
    const acknowledged = await service.acknowledgeOperationalIncident(user, projectId, incidentId, { reason: "Investigating the Redis coordination path." });
    expect(acknowledged.incident.status).toBe("investigating");

    const firstPass = await service.recordTrustHealthSample(user, projectId, sample("pass-1", "passed", 10));
    expect(firstPass.operationalIncident).toMatchObject({ status: "investigating", consecutivePasses: 1 });
    await expect(service.resolveOperationalIncident(user, projectId, incidentId, { reason: "Looks healthy after one run." }))
      .rejects.toMatchObject({ status: 409 });
    const secondPass = await service.recordTrustHealthSample(user, projectId, sample("pass-2", "passed", 20));
    expect(secondPass).toMatchObject({ operationalIncident: { status: "recovered", consecutivePasses: 2 }, incidentTransition: { toStatus: "recovered" } });

    const resolved = await service.resolveOperationalIncident(user, projectId, incidentId, { reason: "Reviewed both passing smoke runs and recovery evidence." });
    expect(resolved.incident).toMatchObject({ status: "resolved", resolvedByEmail: user.email });
    expect((await store.listIncidentTransitions(projectId, incidentId)).map((item) => item.toStatus))
      .toEqual(["open", "investigating", "recovered", "resolved"]);
  });

  it("verifies recipient ownership and records incident email delivery", async () => {
    const provider = new RecordingEmailProvider();
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], undefined, undefined, fetch, provider, "https://agentcert.example",
    );
    const projectId = (await service.bootstrap(user)).project.id;
    const destination = await service.createNotificationDestination(user, projectId, {
      email: "Security@Example.com",
      alertTypes: ["incident_opened", "incident_recovered"],
    });
    expect(destination).toMatchObject({ email: "security@example.com", status: "pending_verification" });
    expect(provider.messages).toHaveLength(0);
    await service.processNotificationJobs("notification-worker");
    expect(provider.messages).toHaveLength(1);
    const token = new URL(provider.messages[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await expect(service.verifyNotificationDestination(token)).resolves.toMatchObject({
      outcome: "verified",
      destination: { status: "active" },
    });

    await service.recordTrustHealthSample(user, projectId, {
      externalId: "notification-failure", source: "production_smoke", status: "failed",
      startedAt: "2026-07-15T10:00:00.000Z", completedAt: "2026-07-15T10:00:05.000Z", checks: [], error: "health failed",
    });
    await service.processNotificationJobs("notification-worker");
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1]).toMatchObject({ to: "security@example.com", subject: expect.stringContaining("opened") });
    expect(await store.listNotificationDeliveries(projectId)).toEqual(expect.arrayContaining([
      { alertType: "incident_opened", status: "delivered" },
      { alertType: "destination_verification", status: "delivered" },
    ].map((item) => expect.objectContaining(item))));
  });

  it("retries failed email delivery, dead-letters it, and permits an explicit replay", async () => {
    const provider = new FailingEmailProvider();
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], undefined, undefined, fetch, provider, "https://agentcert.example",
    );
    const projectId = (await service.bootstrap(user)).project.id;
    await service.createNotificationDestination(user, projectId, {
      email: "security@example.com", alertTypes: ["incident_opened"],
    });

    let [job] = await store.listNotificationJobs(projectId);
    expect(job).toMatchObject({ status: "pending", attemptCount: 0, maxAttempts: 5 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await service.processNotificationJobs("worker-a", new Date(job!.nextAttemptAt));
      [job] = await store.listNotificationJobs(projectId);
      expect(job!.attemptCount).toBe(attempt);
    }

    expect(job).toMatchObject({ status: "dead_letter", attemptCount: 5, lastError: "provider unavailable" });
    expect(provider.attempts).toBe(5);
    expect(await store.listNotificationDeliveries(projectId)).toHaveLength(5);
    await expect(service.retryNotificationJob(user, projectId, job!.id)).resolves.toMatchObject({
      status: "pending", attemptCount: 0, lastError: undefined,
    });
  });

  it("distinguishes first, repeated, expired, and invalid recipient verification", async () => {
    const provider = new RecordingEmailProvider();
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], undefined, undefined, fetch, provider, "https://agentcert.example",
    );
    const projectId = (await service.bootstrap(user)).project.id;
    await service.createNotificationDestination(user, projectId, {
      email: "security@example.com", alertTypes: ["incident_opened"],
    });
    await service.processNotificationJobs("verification-worker");
    const token = new URL(provider.messages[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;

    await expect(service.verifyNotificationDestination(token)).resolves.toMatchObject({
      outcome: "verified", destination: { email: "security@example.com", status: "active" },
    });
    await expect(service.verifyNotificationDestination(token)).resolves.toMatchObject({
      outcome: "already_verified", destination: { status: "active" },
    });

    await service.createNotificationDestination(user, projectId, {
      email: "expired@example.com", alertTypes: ["incident_opened"],
    });
    await service.processNotificationJobs("verification-worker");
    const expiredToken = new URL(provider.messages[1]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await expect(service.verifyNotificationDestination(expiredToken, new Date(Date.now() + 25 * 60 * 60 * 1000)))
      .resolves.toEqual({ outcome: "expired" });
    await expect(service.verifyNotificationDestination("not-a-real-token"))
      .resolves.toEqual({ outcome: "invalid" });
  });

  it("sends a rate-bounded test alert through the delivery ledger without creating an incident", async () => {
    const provider = new RecordingEmailProvider();
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], undefined, undefined, fetch, provider, "https://agentcert.example",
    );
    const projectId = (await service.bootstrap(user)).project.id;
    const pending = await service.createNotificationDestination(user, projectId, {
      email: "security@example.com", alertTypes: ["incident_opened"],
    });
    await expect(service.sendTestNotification(user, projectId, pending.id)).rejects.toMatchObject({ status: 409 });
    await service.processNotificationJobs("verification-worker");
    const token = new URL(provider.messages[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await service.verifyNotificationDestination(token);

    const now = new Date("2026-07-16T20:00:00.000Z");
    const job = await service.sendTestNotification(user, projectId, pending.id, now);
    expect(job).toMatchObject({ alertType: "test_alert", status: "pending", recipient: "security@example.com" });
    await expect(service.sendTestNotification(user, projectId, pending.id, new Date(now.getTime() + 30_000)))
      .rejects.toMatchObject({ status: 429, code: "test_alert_cooldown" });
    await service.processNotificationJobs("test-alert-worker", now);

    expect(await store.listIncidents(projectId)).toHaveLength(0);
    expect(await store.listNotificationDeliveries(projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, alertType: "test_alert", status: "delivered" }),
    ]));
    const operations = await service.operationsOverview(user, projectId, undefined, now);
    expect(operations.notifications.recentJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, alertType: "test_alert", status: "delivered" }),
    ]));
  });

  it("recovers an email job after its worker lease expires", async () => {
    const store = new InMemoryControlPlaneStore();
    await store.enqueueNotificationJob({
      id: "00000000-0000-4000-8000-000000000020", projectId: "p1", destinationId: "d1",
      alertType: "incident_opened", recipient: "security@example.com", subject: "incident", text: "incident", html: "<p>incident</p>",
      status: "processing", attemptCount: 0, maxAttempts: 5, nextAttemptAt: "2026-07-15T00:00:00.000Z",
      lockedAt: "2026-07-15T00:00:00.000Z", lockedBy: "dead-worker", createdAt: "2026-07-15T00:00:00.000Z",
    });
    await expect(store.claimNotificationJobs("worker-b", "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:30.000Z", 10))
      .resolves.toMatchObject([{ status: "processing", lockedBy: "worker-b", lockedAt: "2026-07-15T00:01:00.000Z" }]);
  });

  it("opens a separate incident only after multi-window burn thresholds are crossed", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const sample = (index: number) => ({
      externalId: `burn-failure-${index}`, source: "production_smoke", status: "failed",
      startedAt: `2026-07-15T10:0${index}:00.000Z`, completedAt: `2026-07-15T10:0${index}:05.000Z`,
      checks: ["health"], error: "production smoke failed",
    });

    await service.recordTrustHealthSample(user, projectId, sample(0));
    expect((await store.listIncidents(projectId)).filter((item) => item.type === "slo_burn_rate")).toHaveLength(0);
    await service.recordTrustHealthSample(user, projectId, sample(1));
    expect((await store.listIncidents(projectId)).filter((item) => item.type === "slo_burn_rate")).toHaveLength(0);
    const third = await service.recordTrustHealthSample(user, projectId, sample(2));
    expect(third.sloBurnRate.evaluation.status).toBe("critical");
    expect(third.sloBurnRate.evaluation.windows[0]).toMatchObject({ label: "1h", total: 3, failed: 3 });
    expect(third.sloBurnRate.operationalIncident).toMatchObject({ type: "slo_burn_rate", status: "open" });
  });

  it("does not change incident state when the atomic transition write fails", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(user)).project.id;
    const opened = await service.recordTrustHealthSample(user, projectId, {
      externalId: "atomic-failure", source: "production_smoke", status: "failed",
      startedAt: "2026-07-15T11:00:00.000Z", completedAt: "2026-07-15T11:00:05.000Z", checks: [], error: "health failed",
    });
    const incidentId = opened.operationalIncident!.id;
    vi.spyOn(store, "updateIncidentWithTransition").mockRejectedValueOnce(new Error("transition insert failed"));

    await expect(service.acknowledgeOperationalIncident(user, projectId, incidentId, {
      reason: "Investigating the failed transition transaction.",
    })).rejects.toThrow("transition insert failed");
    await expect(store.getIncident(projectId, incidentId)).resolves.toMatchObject({ status: "open" });
    expect(await store.listIncidentTransitions(projectId, incidentId)).toHaveLength(1);
  });
});

class RecordingEmailProvider implements EmailProvider {
  readonly name = "test";
  readonly configured = true;
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) { this.messages.push(message); return { provider: this.name, messageId: `message-${this.messages.length}` }; }
}

class FailingEmailProvider implements EmailProvider {
  readonly name = "failing-test";
  readonly configured = true;
  attempts = 0;
  async send(_message: EmailMessage): Promise<{ provider: string; messageId?: string }> {
    this.attempts += 1;
    throw new Error("provider unavailable");
  }
}

describe("Redis coordination primitives", () => {
  it.each(["agentcert-coordination:6379", "https://agentcert-coordination:6379", "redis-cli -u redis://host:6379"])(
    "rejects an invalid REDIS_URL before connecting: %s",
    async (url) => {
      await expect(createRedisCoordination(url, 3, 1_000)).rejects.toThrow(
        "REDIS_URL must be a valid redis:// or rediss:// connection URL.",
      );
    },
  );

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
