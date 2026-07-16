import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { Authenticator } from "../src/auth.js";
import { createRedisCoordination } from "../src/coordination.js";
import { FixedWindowRateLimiter } from "../src/security.js";
import { AgentCertControlPlane } from "../src/service.js";
import { createControlPlaneHttpServer } from "../src/server.js";
import { InMemoryControlPlaneStore, PostgresControlPlaneStore } from "../src/store.js";

const servers: Array<ReturnType<typeof createControlPlaneHttpServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("Production Acceptance Lab", () => {
  it("keeps tenant records isolated across direct and API-key access", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const first = { kind: "user", userId: randomUUID(), email: "first@example.com" } as const;
    const second = { kind: "user", userId: randomUUID(), email: "second@example.com" } as const;
    const firstProject = (await service.bootstrap(first)).project.id;
    const secondProject = (await service.bootstrap(second)).project.id;
    await service.startRun(first, firstProject, { externalId: "private-run", kind: "custom" });
    await expect(service.listRuns(second, firstProject)).rejects.toMatchObject({ status: 403 });
    await expect(service.listRuns({ kind: "api_key", projectId: secondProject, scopes: ["runs:read"] }, firstProject))
      .rejects.toMatchObject({ status: 403, code: "api_key_project_mismatch" });
  });

  it("fuzzes authenticated JSON routes without producing internal errors", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    await service.bootstrap({ kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "developer@localhost" });
    const server = createControlPlaneHttpServer({
      service, authenticator: new Authenticator({ store, devMode: true }), publicConfig: {
        kind: "agentcert.control_plane_config", hosted: true, publicUrl: "http://127.0.0.1", auth: { provider: "development", registrationOpen: true },
      }, host: "127.0.0.1", port: 0, dashboardDir: ".", maxArtifactBytes: 1024, rateLimiter: new FixedWindowRateLimiter(500, 60_000),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const bodies: unknown[] = [null, [], true, 1, "name", {}, { name: "" }, { name: "x".repeat(300) },
      { name: { nested: true } }, { __proto__: { polluted: true } }, ...Array.from({ length: 40 }, (_, index) => ({ name: index % 3 ? `fuzz-${index}` : index }))];
    const statuses = await Promise.all(bodies.map(async (body) => (await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      method: "POST", headers: { authorization: "Bearer dev-local-token", "content-type": "application/json" }, body: JSON.stringify(body),
    })).status));
    expect(statuses.every((status) => status >= 200 && status < 500)).toBe(true);
    expect(statuses).not.toContain(500);
  });
});

describe.skipIf(!process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL)("Postgres recovery acceptance", () => {
  it("reconnects after a pool shutdown without losing tenant state", async () => {
    const url = process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL!;
    const userId = randomUUID();
    const first = new PostgresControlPlaneStore(url);
    await first.migrate();
    const project = (await first.bootstrapUser(userId, `${userId}@example.test`)).project;
    await first.close();
    const recovered = new PostgresControlPlaneStore(url);
    await expect(recovered.getProject(project.id)).resolves.toMatchObject({ id: project.id });
    await recovered.close();
  });
});

describe.skipIf(!process.env.AGENTCERT_ACCEPTANCE_REDIS_URL)("Redis recovery acceptance", () => {
  it("reconnects shared rate limiting and idempotency after a client shutdown", async () => {
    const url = process.env.AGENTCERT_ACCEPTANCE_REDIS_URL!;
    const first = await createRedisCoordination(url, 2, 10_000);
    await expect(first.idempotency.runExclusive("acceptance", async () => "first")).resolves.toEqual({ acquired: true, value: "first" });
    await first.close();
    expect(first.health().state).toBe("degraded");
    const recovered = await createRedisCoordination(url, 2, 10_000);
    await expect(recovered.idempotency.runExclusive("acceptance", async () => "recovered")).resolves.toEqual({ acquired: true, value: "recovered" });
    expect(recovered.health()).toMatchObject({ backend: "redis", state: "ready", shared: true });
    await recovered.close();
  });
});
