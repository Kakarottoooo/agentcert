import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
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
  it("serializes concurrent migration starts and records the complete immutable ledger", async () => {
    const url = process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL!;
    const first = new PostgresControlPlaneStore(url);
    const second = new PostgresControlPlaneStore(url);
    const inspector = new pg.Pool({ connectionString: url });
    try {
      await Promise.all([first.migrate(), second.migrate()]);
      const ledger = await inspector.query("SELECT name,sha256 FROM agentcert_schema_migrations ORDER BY name");
      expect(ledger.rows).toHaveLength(24);
      expect(ledger.rows[0]).toMatchObject({ name: "001_initial.sql" });
      expect(ledger.rows.at(-1)).toMatchObject({ name: "024_browser_enforcement_boundary.sql" });
      expect(ledger.rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.sha256)))).toBe(true);
      const relations = await inspector.query(`SELECT
        to_regclass('public.agentcert_capability_manifests') AS semantics,
        to_regclass('public.agentcert_action_mandates') AS mandates,
        to_regclass('public.agentcert_execution_grants') AS grants`);
      expect(relations.rows[0]).toMatchObject({
        semantics: "agentcert_capability_manifests",
        mandates: "agentcert_action_mandates",
        grants: "agentcert_execution_grants",
      });
    } finally {
      await Promise.all([first.close(), second.close(), inspector.end()]);
    }
  });

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

  it("persists semantic corrections across a hosted restart without crossing tenants", async () => {
    const url = process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL!;
    const ownerId = randomUUID();
    const owner = { kind: "user", userId: ownerId, email: `${ownerId}@example.test` } as const;
    const outsider = { kind: "user", userId: randomUUID(), email: `${randomUUID()}@example.test` } as const;
    const firstStore = new PostgresControlPlaneStore(url);
    await firstStore.migrate();
    const firstService = new AgentCertControlPlane(firstStore, new MemoryArtifactStore());
    const projectId = (await firstService.bootstrap(owner)).project.id;
    const outsiderProjectId = (await firstService.bootstrap(outsider)).project.id;
    const run = await firstService.startRun(owner, projectId, { externalId: `semantic-postgres-${randomUUID()}`, kind: "custom", metadata: { framework: "private-agent" } });
    await firstService.appendEvents(owner, projectId, run.id, { events: [{
      sequence: 0, type: "tool.completed", payload: { toolName: "customer_inventory_lookup" },
    }] });
    const before = await firstService.semanticCoverage(owner, projectId, 30);
    expect(before).toMatchObject({ totals: { recognizedEvents: 0, unknownEvents: 1 } });
    await firstService.reviewUnknownCapability(owner, projectId, before.unknown[0]!.key, {
      capabilityId: "data.query", confidence: 1, rationale: "Customer-reviewed inventory lookup reads structured data.",
    });
    const apiKey = await firstService.createApiKey(owner, projectId, { name: "Semantic Postgres E2E" });
    await firstStore.close();

    const recoveredStore = new PostgresControlPlaneStore(url);
    const recoveredService = new AgentCertControlPlane(recoveredStore, new MemoryArtifactStore());
    const server = createControlPlaneHttpServer({
      service: recoveredService, authenticator: new Authenticator({ store: recoveredStore }), publicConfig: {
        kind: "agentcert.control_plane_config", hosted: true, publicUrl: "http://127.0.0.1", auth: { provider: "development", registrationOpen: true },
      }, host: "127.0.0.1", port: 0, dashboardDir: ".", maxArtifactBytes: 1024, rateLimiter: new FixedWindowRateLimiter(100, 60_000),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects/${projectId}/semantics/coverage?days=30`, {
      headers: { authorization: `Bearer ${apiKey.secret}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId, totals: { recognizedEvents: 1, unknownEvents: 0 },
      coverage: { semantic: { numerator: 1, denominator: 1, percent: 100 } },
      manifests: { corrections: 1 },
    });
    await expect(recoveredService.semanticCoverage(owner, outsiderProjectId, 30)).rejects.toMatchObject({ status: 403 });
    await recoveredStore.close();
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
