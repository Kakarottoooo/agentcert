import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { LocalIdempotencyCoordinator } from "../src/coordination.js";
import { FixedWindowRateLimiter } from "../src/security.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner, verifyEvidenceAttestation } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext, MemberRole } from "../src/types.js";

const owner: AuthContext = { kind: "user", userId: "owner", email: "owner@example.com" };

class RoleMatrixStore extends InMemoryControlPlaneStore {
  readonly assignedRoles = new Map<string, MemberRole>();

  override async roleForProject(userId: string, projectId: string): Promise<MemberRole | undefined> {
    return this.assignedRoles.get(`${projectId}:${userId}`) ?? super.roleForProject(userId, projectId);
  }
}

describe("production RBAC acceptance matrix", () => {
  it("keeps read, administration, review, and API-key scopes separated", async () => {
    const store = new RoleMatrixStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const projectId = (await service.bootstrap(owner)).project.id;
    const users = {
      admin: { kind: "user", userId: "admin", email: "admin@example.com" } as const,
      reviewer: { kind: "user", userId: "reviewer", email: "reviewer@example.com" } as const,
      viewer: { kind: "user", userId: "viewer", email: "viewer@example.com" } as const,
    };
    store.assignedRoles.set(`${projectId}:admin`, "admin");
    store.assignedRoles.set(`${projectId}:reviewer`, "reviewer");
    store.assignedRoles.set(`${projectId}:viewer`, "viewer");
    const run = await service.startRun(owner, projectId, { externalId: "security-run", kind: "custom" });

    for (const auth of [owner, users.admin, users.reviewer, users.viewer]) {
      await expect(service.listRuns(auth, projectId)).resolves.toHaveLength(1);
    }
    for (const auth of [owner, users.admin]) {
      await expect(service.createApiKey(auth, projectId, { name: `${auth.userId}-key`, scopes: ["runs:read"] }))
        .resolves.toMatchObject({ apiKey: { scopes: ["runs:read"] } });
    }
    for (const auth of [users.reviewer, users.viewer]) {
      await expect(service.createApiKey(auth, projectId, { name: "forbidden" })).rejects.toMatchObject({ status: 403 });
    }

    await expect(service.reviewFailure(users.reviewer, projectId, run.id, {
      patternKey: "timeout-1", type: "timeout", status: "confirmed", confidence: 0.9,
      evidenceContext: {}, taxonomyRationale: { primaryReason: "The agent exceeded the declared execution deadline." },
    })).resolves.toMatchObject({ reviewerId: "reviewer", status: "confirmed" });
    await expect(service.reviewFailure(users.viewer, projectId, run.id, {
      patternKey: "timeout-2", type: "timeout", status: "confirmed",
      evidenceContext: {}, taxonomyRationale: { primaryReason: "The agent exceeded the declared execution deadline." },
    })).rejects.toMatchObject({ status: 403 });

    for (const [index, auth] of [owner, users.admin, users.reviewer].entries()) {
      const action = await service.proposeAction(owner, projectId, {
        externalId: `approval-${index}`, actionType: "SUBMIT", targetSystem: "sandbox-erp", amount: 2_000,
      });
      await expect(service.reviewAction(auth, projectId, action.id, true, { comment: "Approved in the security acceptance matrix." }))
        .resolves.toMatchObject({ status: "APPROVED" });
    }
    const viewerAction = await service.proposeAction(owner, projectId, {
      externalId: "approval-viewer", actionType: "SUBMIT", targetSystem: "sandbox-erp", amount: 2_000,
    });
    await expect(service.reviewAction(users.viewer, projectId, viewerAction.id, true, {})).rejects.toMatchObject({ status: 403 });

    const readOnlyKey: AuthContext = { kind: "api_key", projectId, scopes: ["runs:read"] };
    await expect(service.listRuns(readOnlyKey, projectId)).resolves.toHaveLength(1);
    await expect(service.startRun(readOnlyKey, projectId, { externalId: "scope-bypass", kind: "custom" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.listRuns({ ...readOnlyKey, projectId: "another-project" }, projectId))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("production concurrency and pressure acceptance", () => {
  it("admits only one concurrent execution for the same idempotency key", async () => {
    const coordinator = new LocalIdempotencyCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const attempts = Array.from({ length: 32 }, () => coordinator.runExclusive("project:operation:key", async () => {
      executions += 1;
      await gate;
      return "completed";
    }));
    release();
    const results = await Promise.all(attempts);
    expect(executions).toBe(1);
    expect(results.filter((result) => result.acquired)).toEqual([{ acquired: true, value: "completed" }]);
    await expect(coordinator.runExclusive("project:operation:key", async () => "recovered"))
      .resolves.toEqual({ acquired: true, value: "recovered" });
  });

  it("enforces the exact pressure boundary and resets the next fixed window", () => {
    const limiter = new FixedWindowRateLimiter(300, 60_000);
    const results = Array.from({ length: 1_000 }, () => limiter.consume("api-key", 1_000));
    expect(results.filter((result) => result.allowed)).toHaveLength(300);
    expect(results.slice(300).every((result) => !result.allowed && result.remaining === 0)).toBe(true);
    expect(limiter.consume("api-key", 61_000)).toMatchObject({ allowed: true, remaining: 299 });
    expect(limiter.consume("another-api-key", 1_000)).toMatchObject({ allowed: true, remaining: 299 });
  });
});

describe("production signing-key rotation rehearsal", () => {
  it("activates a replacement key while retaining old public verification material", async () => {
    const store = new InMemoryControlPlaneStore();
    const firstPair = generateKeyPairSync("ed25519");
    const secondPair = generateKeyPairSync("ed25519");
    const first = new EvidenceSigner("evidence-2026-q3", firstPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const second = new EvidenceSigner("evidence-2026-q4", secondPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const payload = { evidenceId: "e-1", projectId: "p-1", kind: "trace", schemaVersion: "agentcert.evidence.v0.1", sha256: "ab".repeat(32), sizeBytes: 2, createdAt: "2026-07-15T00:00:00.000Z" };
    const oldAttestation = first.attest(payload, "2026-07-15T00:00:01.000Z");

    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], first)
      .activateSigningKey(new Date("2026-07-15T00:00:00.000Z"));
    await new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], second)
      .activateSigningKey(new Date("2026-10-15T00:00:00.000Z"));
    const oldKey = await store.getSigningKey(first.keyId);
    const activeKey = await store.getSigningKey(second.keyId);

    expect(oldKey).toMatchObject({ status: "retired", retiredAt: "2026-10-15T00:00:00.000Z" });
    expect(activeKey).toMatchObject({ status: "active" });
    expect(verifyEvidenceAttestation(payload, oldAttestation, oldKey!.publicKeyPem)).toBe(true);
  });
});
