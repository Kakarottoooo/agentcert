import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import type { EvidenceGovernancePolicy } from "../src/evidence-governance.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext, EvidenceRecord } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

async function setup(policy?: EvidenceGovernancePolicy) {
  const store = new InMemoryControlPlaneStore();
  const artifacts = new MemoryArtifactStore();
  const service = new AgentCertControlPlane(store, artifacts, policy);
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

  it("treats an external run ID as an idempotency key", async () => {
    const { service, projectId } = await setup();
    const first = await service.startRun(user, projectId, { externalId: "ci-retry", kind: "tripwire" });
    await service.completeRun(user, projectId, first.id, { status: "failed", score: 0.4 });

    const retried = await service.startRun(user, projectId, { externalId: "ci-retry", kind: "tripwire" });
    const completed = await service.completeRun(user, projectId, retried.id, { status: "failed", score: 0.4 });

    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("failed");
    expect(completed.id).toBe(first.id);
    expect(await service.listIncidents(user, projectId)).toHaveLength(1);
    await expect(service.completeRun(user, projectId, first.id, { status: "passed", score: 1 }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409 });
  });

  it("stores evidence with hash provenance and project-scoped retrieval", async () => {
    const { service, projectId } = await setup();
    const evidence = await service.uploadEvidence(user, projectId, Buffer.from('{"trace":true}'), {
      fileName: "trace.json", contentType: "application/json", kind: "trace", schemaVersion: "agentcert.evidence.v0.1",
      sourcePath: ".tripwire/latest/trace.json",
    });
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.metadata).toMatchObject({ sourcePath: ".tripwire/latest/trace.json", format: "JSON" });
    expect(evidence.metadata.retentionExpiresAt).toEqual(expect.any(String));
    const result = await service.readEvidence(user, projectId, evidence.id);
    expect(result.artifact.bytes.toString()).toBe('{"trace":true}');
    await expect(service.uploadEvidence(user, projectId, Buffer.from("bad"), {
      fileName: "trace.json", contentType: "application/json", kind: "trace", schemaVersion: "agentcert.evidence.v0.1",
      sourcePath: "x".repeat(1025),
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 400 });
  });

  it("deduplicates repeated evidence uploads for the same run and digest", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "retryable-ci-run", kind: "tripwire" });
    const input = {
      fileName: "agentcert-evidence.json",
      contentType: "application/json",
      kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      runId: run.id,
    };

    const first = await service.uploadEvidence(user, projectId, Buffer.from('{"same":true}'), input);
    const retried = await service.uploadEvidence(user, projectId, Buffer.from('{"same":true}'), input);

    expect(retried.id).toBe(first.id);
    expect(await service.listEvidence(user, projectId)).toHaveLength(1);
  });

  it("enforces run and project evidence quotas without retaining rejected objects", async () => {
    const runScoped = await setup({ projectLimitBytes: 100, runLimitBytes: 5, retentionDays: 90 });
    const run = await runScoped.service.startRun(user, runScoped.projectId, { externalId: "run-quota", kind: "tripwire" });
    await runScoped.service.uploadEvidence(user, runScoped.projectId, Buffer.from("{}"), {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    });
    await expect(runScoped.service.uploadEvidence(user, runScoped.projectId, Buffer.from('{"x":1}'), {
      fileName: "trace.json", contentType: "application/json", kind: "trace",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 413 });
    expect(await runScoped.store.evidenceUsage(runScoped.projectId, run.id)).toEqual({ count: 1, bytes: 2 });
    expect((await runScoped.service.runAnalysis(user, runScoped.projectId, run.id)).evidenceCompleteness.status).toBe("rejected");

    const projectScoped = await setup({ projectLimitBytes: 5, runLimitBytes: 100, retentionDays: 90 });
    await projectScoped.service.uploadEvidence(user, projectScoped.projectId, Buffer.from("{}"), {
      fileName: "first.json", contentType: "application/json", kind: "json", schemaVersion: "agentcert.evidence.v0.1",
    });
    await expect(projectScoped.service.uploadEvidence(user, projectScoped.projectId, Buffer.from('{"x":1}'), {
      fileName: "second.json", contentType: "application/json", kind: "json", schemaVersion: "agentcert.evidence.v0.1",
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 413 });
    expect(await projectScoped.store.evidenceUsage(projectScoped.projectId)).toEqual({ count: 1, bytes: 2 });
    expect((await projectScoped.service.overview(user, projectScoped.projectId)).storage).toMatchObject({
      usedBytes: 2, limitBytes: 5, remainingBytes: 3, retentionDays: 90,
    });
  });

  it("reports complete, partial, and rejected evidence states from hosted artifacts", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "evidence-state", kind: "tripwire" });
    const bundle = Buffer.from(JSON.stringify({ artifacts: { screenshot: "screenshots/step.png" } }));
    await service.uploadEvidence(user, projectId, bundle, {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    });
    expect((await service.runAnalysis(user, projectId, run.id)).evidenceCompleteness).toMatchObject({
      status: "partial", evidenceCount: 1,
    });
    await service.appendEvents(user, projectId, run.id, {
      events: [{ sequence: 0, type: "agentcert.companion_artifacts.processed", payload: { uploadedCount: 1, skippedCount: 0 } }],
    });
    expect((await service.runAnalysis(user, projectId, run.id)).evidenceCompleteness.status).toBe("partial");

    await service.uploadEvidence(user, projectId, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), {
      fileName: "step.png", contentType: "image/png", kind: "screenshot",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id, sourcePath: "screenshots/step.png",
    });
    expect((await service.runAnalysis(user, projectId, run.id)).evidenceCompleteness).toMatchObject({
      status: "complete", evidenceCount: 2,
    });

    await expect(service.uploadEvidence(user, projectId, Buffer.from("MZpayload"), {
      fileName: "hostile.json", contentType: "application/json", kind: "trace",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 415 });
    const rejected = await service.runAnalysis(user, projectId, run.id);
    expect(rejected.evidenceCompleteness.status).toBe("rejected");
    expect(rejected.evidenceCompleteness.reasons[0]).toContain("Executable files");
  });

  it("deletes expired objects before metadata and retains metadata when object deletion fails", async () => {
    const { service, store, artifacts, projectId } = await setup();
    const old = evidenceRecord(projectId, "old", "2025-01-01T00:00:00.000Z");
    const recent = evidenceRecord(projectId, "recent", "2025-12-20T00:00:00.000Z");
    await store.insertEvidence(old);
    await store.insertEvidence(recent);
    await artifacts.put(old.objectKey, Buffer.from("{}"), old.contentType);
    await artifacts.put(recent.objectKey, Buffer.from("{}"), recent.contentType);

    const result = await service.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"));
    expect(result).toMatchObject({ scanned: 1, deleted: 1, bytesDeleted: 2, failed: 0 });
    expect(await store.getEvidence(projectId, old.id)).toBeUndefined();
    expect(await artifacts.get(old.objectKey)).toBeUndefined();
    expect(await store.getEvidence(projectId, recent.id)).toEqual(recent);

    class FailingDeleteStore extends MemoryArtifactStore {
      override async delete(): Promise<void> { throw new Error("storage unavailable"); }
    }
    const failingArtifacts = new FailingDeleteStore();
    const failingService = new AgentCertControlPlane(store, failingArtifacts);
    const failed = evidenceRecord(projectId, "failed", "2025-01-02T00:00:00.000Z");
    await store.insertEvidence(failed);
    await failingArtifacts.put(failed.objectKey, Buffer.from("{}"), failed.contentType);
    const failure = await failingService.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"));
    expect(failure).toMatchObject({ scanned: 1, deleted: 0, failed: 1 });
    expect(await store.getEvidence(projectId, failed.id)).toEqual(failed);
  });

  it("persists human failure reviews in run analysis and updates the same pattern", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "taxonomy-review", kind: "tripwire" });
    await service.appendEvents(user, projectId, run.id, {
      events: [{ sequence: 0, type: "assertion.failed", payload: { message: "Agent clicked Cancel." } }],
    });
    const evidence = await service.uploadEvidence(user, projectId, Buffer.from("{}"), {
      fileName: "agentcert-evidence.json",
      contentType: "application/json",
      kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      runId: run.id,
    });

    const first = await service.reviewFailure(user, projectId, run.id, {
      patternKey: "wrong-click:cancel",
      suggestedType: "wrong_click",
      type: "wrong_click",
      status: "confirmed",
      confidence: 0.82,
      note: "The click target changed after the popup appeared.",
      evidenceContext: {
        firstDivergenceSnippet: "Agent clicked Cancel instead of Continue.",
        screenshotPointer: "screenshots/step-4.png",
        tracePointer: "trace.json",
        stepIndex: 4,
      },
      taxonomyRationale: {
        primaryReason: "The first divergent action selected the wrong control.",
        supportingSignals: ["failed final-state assertion", "cancel click in trace"],
      },
    });
    const corrected = await service.reviewFailure(user, projectId, run.id, {
      patternKey: "wrong-click:cancel",
      suggestedType: "wrong_click",
      type: "ui_drift",
      status: "corrected",
      confidence: 0.95,
      taxonomyRationale: {
        primaryReason: "The control label changed before the wrong click.",
        classifierLimitation: "The automatic rule saw the click but not the preceding DOM mutation.",
      },
    });

    expect(corrected.id).toBe(first.id);
    expect(corrected.type).toBe("ui_drift");
    expect(corrected.reviewer).toBe("owner@example.com");
    const analysis = await service.runAnalysis(user, projectId, run.id);
    expect(analysis.events).toHaveLength(1);
    expect(analysis.evidence).toEqual([evidence]);
    expect(analysis.reviews).toEqual([corrected]);
  });

  it("allows machine credentials to read analysis but not create human reviews", async () => {
    const { service, projectId } = await setup();
    const machine: AuthContext = { kind: "api_key", projectId, apiKeyId: "key-1" };
    const run = await service.startRun(machine, projectId, { externalId: "machine-analysis", kind: "tripwire" });

    await expect(service.runAnalysis(machine, projectId, run.id)).resolves.toMatchObject({ run: { id: run.id } });
    await expect(service.reviewFailure(machine, projectId, run.id, {
      patternKey: "timeout:step-2",
      type: "timeout",
      status: "confirmed",
      taxonomyRationale: { primaryReason: "The step exceeded the deadline." },
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
  });

  it("keeps run analysis and reviews project scoped", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "isolated-analysis", kind: "tripwire" });
    const otherProject = "00000000-0000-4000-8000-000000000099";

    await expect(service.runAnalysis(user, otherProject, run.id))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
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

function evidenceRecord(projectId: string, id: string, createdAt: string): EvidenceRecord {
  return {
    id, projectId, kind: "json", schemaVersion: "agentcert.evidence.v0.1", objectKey: `${projectId}/${id}.json`,
    fileName: `${id}.json`, contentType: "application/json", sha256: id.padEnd(64, "0"), sizeBytes: 2,
    metadata: {}, createdAt,
  };
}
