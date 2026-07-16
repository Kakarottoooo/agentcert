import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

describe("tenant isolation concurrency", () => {
  it("keeps concurrent project, run, evidence, and feedback writes inside 100 tenants", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
    const tenants = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const auth: AuthContext = { kind: "user", userId: `user-${index}`, email: `tenant-${index}@example.com` };
      const bootstrap = await service.bootstrap(auth);
      const project = await service.createProject(auth, { name: `Agent ${index}` });
      const run = await service.startRun(auth, project.id, { externalId: `run-${index}`, kind: "custom" });
      await service.uploadEvidence(auth, project.id, Buffer.from(`{"tenant":${index}}`), {
        fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle",
        schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
      });
      await service.submitPilotFeedback(auth, project.id, {
        stage: "dashboard_review", category: "dashboard", outcome: "completed", reasonCode: "stress_complete",
      });
      return { auth, bootstrapProjectId: bootstrap.project.id, projectId: project.id, runId: run.id };
    }));

    await Promise.all(tenants.map(async (tenant, index) => {
      const own = await service.overview(tenant.auth, tenant.projectId);
      expect(own.summary).toMatchObject({ runs: 1, evidence: 1 });
      expect(await service.projects(tenant.auth)).toHaveLength(2);
      const other = tenants[(index + 1) % tenants.length]!;
      await expect(service.overview(tenant.auth, other.projectId))
        .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
      await expect(service.submitPilotFeedback(tenant.auth, other.projectId, {
        stage: "project", category: "other", outcome: "suggestion", reasonCode: "cross_tenant",
      })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
    }));
  });
});
