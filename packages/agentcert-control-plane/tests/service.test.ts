import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const artifacts = new MemoryArtifactStore();
  const service = new AgentCertControlPlane(store, artifacts);
  const bootstrap = await service.bootstrap(user);
  return { store, artifacts, service, projectId: bootstrap.project.id };
}

describe("AgentCertControlPlane", () => {
  it("requires approval, prevents agent self-approval, verifies the outcome, and retains audit state", async () => {
    const { service, projectId } = await setup();
    const agent = await service.createAgent(user, projectId, {
      externalId: "procurement-agent",
      name: "ProcurementAgent",
      version: "1.0.0",
      allowedPermissions: ["MockERP:SUBMIT"],
    });
    const action = await service.proposeAction({ kind: "api_key", projectId, apiKeyId: "key-1" }, projectId, {
      externalId: "po-4850",
      agentId: agent.id,
      principal: { id: "procurement-agent", type: "agent" },
      actionType: "SUBMIT",
      targetSystem: "MockERP",
      requestedPermissions: ["MockERP:SUBMIT"],
      amount: 4850,
      currency: "USD",
      expectedState: { status: "SUBMITTED" },
    });

    expect(action.decision).toBe("REQUIRE_APPROVAL");
    expect(action.status).toBe("PENDING_APPROVAL");
    await expect(
      service.reviewAction({ kind: "api_key", projectId }, projectId, action.id, true, {}),
    ).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });

    const approved = await service.reviewAction(user, projectId, action.id, true, { comment: "Approved by procurement manager." });
    expect(approved.status).toBe("APPROVED");
    const verified = await service.verifyAction({ kind: "api_key", projectId }, projectId, action.id, {
      observedState: { status: "SUBMITTED", vendor: "Acme Industrial Supply" },
    });
    expect(verified.status).toBe("VERIFIED");
    expect(verified.verificationSuccess).toBe(true);
    expect(await service.listIncidents(user, projectId)).toEqual([]);
  });

  it("denies missing permissions before risk policy can allow an action", async () => {
    const { service, projectId } = await setup();
    const agent = await service.createAgent(user, projectId, {
      externalId: "limited-agent",
      name: "LimitedAgent",
      allowedPermissions: [],
    });
    const action = await service.proposeAction(user, projectId, {
      externalId: "update-1",
      agentId: agent.id,
      principal: { id: "limited-agent" },
      actionType: "UPDATE",
      targetSystem: "MockCRM",
      requestedPermissions: ["MockCRM:UPDATE"],
      expectedState: { status: "UPDATED" },
    });
    expect(action.decision).toBe("DENY");
    expect(action.status).toBe("DENIED");
    expect(action.reasons[0]).toContain("Missing permissions");
  });

  it("prevents machine credentials from changing agent identity or permissions", async () => {
    const { service, projectId } = await setup();
    await expect(service.createAgent({ kind: "api_key", projectId, apiKeyId: "key-1" }, projectId, {
      externalId: "self-granting-agent",
      name: "SelfGrantingAgent",
      allowedPermissions: ["Payments:PAY"],
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
  });

  it("creates incidents for failed runs and verification mismatches", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "ci-100", kind: "tripwire" });
    await service.appendEvents(user, projectId, run.id, { events: [{ sequence: 0, type: "run.started" }, { sequence: 1, type: "assertion.failed", payload: { assertion: "final_url" } }] });
    await service.completeRun(user, projectId, run.id, { status: "failed", score: 0.4, firstDivergence: "Clicked misleading button." });

    const action = await service.proposeAction(user, projectId, {
      externalId: "send-1", principal: { id: "mail-agent" }, actionType: "SEND", targetSystem: "MockMail",
      requestedPermissions: [], expectedState: { delivered: true },
    });
    await service.verifyAction(user, projectId, action.id, { observedState: { delivered: false } });
    const incidents = await service.listIncidents(user, projectId);
    expect(incidents.map((item) => item.type).sort()).toEqual(["run_failure", "verification_gap"]);
  });

  it("stores evidence with hash provenance and project-scoped retrieval", async () => {
    const { service, projectId } = await setup();
    const evidence = await service.uploadEvidence(user, projectId, Buffer.from("evidence"), {
      fileName: "trace.json", contentType: "application/json", kind: "trace", schemaVersion: "agentcert.evidence.v0.1",
    });
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    const result = await service.readEvidence(user, projectId, evidence.id);
    expect(result.artifact.bytes.toString()).toBe("evidence");
  });

  it("creates project-scoped API keys and returns the secret only once", async () => {
    const { service, store, projectId } = await setup();
    const result = await service.createApiKey(user, projectId, { name: "CI" });
    expect(result.secret).toMatch(/^ac_live_/);
    expect(result.apiKey).not.toHaveProperty("secretHash");
    expect(await service.listApiKeys(user, projectId)).toEqual([result.apiKey]);
    const listed = await store.listApiKeys(projectId);
    expect(listed[0].name).toBe("CI");
    expect(listed[0].secretHash).not.toContain(result.secret);
    const revoked = await service.revokeApiKey(user, projectId, result.apiKey.id);
    expect(revoked.revokedAt).toBeDefined();
    expect(await store.findApiKeyByHash(listed[0].secretHash)).toBeUndefined();
  });
});
