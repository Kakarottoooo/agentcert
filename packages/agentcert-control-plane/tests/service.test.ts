import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { applyContinuousAssuranceObservation, markContinuousAssuranceCurrent } from "../src/continuous-assurance.js";
import type { EvidenceGovernancePolicy } from "../src/evidence-governance.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext, EvidenceRecord } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

async function setup(policy?: EvidenceGovernancePolicy, platformAdminEmails: string[] = []) {
  const store = new InMemoryControlPlaneStore();
  const artifacts = new MemoryArtifactStore();
  const service = new AgentCertControlPlane(store, artifacts, policy, platformAdminEmails);
  const bootstrap = await service.bootstrap(user);
  return { store, artifacts, service, projectId: bootstrap.project.id };
}

describe("AgentCertControlPlane", () => {
  it("creates a clearly named default assurance project", async () => {
    const store = new InMemoryControlPlaneStore();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore());

    const result = await service.bootstrap(user);

    expect(result.project).toMatchObject({ name: "Agent assurance project", slug: "agent-assurance" });
  });

  it("returns the role-aware next action from the aggregated project state", async () => {
    const { service, projectId } = await setup();
    const baselineOverview = await service.overview(user, projectId);
    expect(baselineOverview).toMatchObject({
      currentAssurance: { status: "NOT_CONFIGURED" },
      nextAction: { kind: "ESTABLISH_BASELINE", permission: { canPerform: true, actor: "owner" } },
    });

    const action = await service.proposeAction(user, projectId, {
      externalId: "approval-next-action", actionType: "SUBMIT", targetSystem: "sandbox-erp", amount: 2_000,
    });
    const actionOverview = await service.overview(user, projectId);
    expect(actionOverview.nextAction).toMatchObject({
      kind: "REVIEW_PENDING_ACTION", context: { actionId: action.id }, permission: { canPerform: true },
    });
  });

  it("persists human capability corrections and recomputes semantic coverage", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "semantic-run", kind: "custom", metadata: { framework: "langgraph" } });
    await service.appendEvents(user, projectId, run.id, { events: [{
      sequence: 0,
      type: "agentcert.tool.completed",
      payload: { semantic: { schemaVersion: "agentcert.semantic_event.v0.1", observedName: "vendor_lookup", invocationId: "invoke-1", phase: "completed" } },
    }] });

    const before = await service.semanticCoverage(user, projectId, 30);
    expect(before.unknown).toMatchObject([{ observedName: "vendor_lookup", occurrences: 1 }]);
    const correction = await service.reviewUnknownCapability(user, projectId, before.unknown[0]!.key, {
      capabilityId: "coding.read", confidence: 0.9, rationale: "The tool reads a vendor-owned source repository without modifying it.",
    });
    const after = await service.semanticCoverage(user, projectId, 30);

    expect(correction).toMatchObject({ capabilityId: "coding.read", source: "human", reviewerEmail: user.email });
    expect(after.unknown).toEqual([]);
    expect(after.domains.find((item) => item.domain === "coding")).toMatchObject({ observed: 1, recognized: 1 });
    expect((await service.listCapabilityCorrections(user, projectId)).corrections).toEqual([correction]);
  });

  it("does not apply an unrelated CURRENT review to semantic events from another run", async () => {
    const { service, store, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "unreviewed-run", kind: "custom" });
    await service.appendEvents(user, projectId, run.id, { events: [{
      sequence: 0,
      type: "agentcert.tool.completed",
      payload: { semantic: {
        schemaVersion: "agentcert.semantic_event.v0.1", capabilityId: "coding.read",
        observedName: "read_file", invocationId: "invoke-unreviewed", phase: "completed",
      } },
    }] });
    const assuranceCase = await service.createAssuranceCase(user, projectId, {
      name: "Unrelated reviewed release",
      subject: { id: "other-agent", name: "Other Agent", version: "1.0.0", kind: "coding" },
      policyPackVersion: "agentcert.base.v0.1",
      evaluationPlan: {
        requiredEvidenceKinds: ["evidence_bundle"],
        controls: [{ id: "semantic-review", title: "Review declared semantic coverage", mode: "manual" }],
      },
      continuousAssurance: { scope: {
        schemaVersion: "agentcert.assurance_scope.v0.1",
        agent: { id: "other-agent", version: "1.0.0", artifactSha256: "a".repeat(64) },
        model: { provider: "deterministic", name: "scripted-agent", version: "1.0.0" },
        prompt: { sha256: "b".repeat(64) },
        tools: { manifestSha256: "c".repeat(64) },
        policy: { id: "agentcert.base.v0.1", version: "agentcert.base.v0.1", sha256: "d".repeat(64) },
        scenarioSuite: { id: "other-suite", version: "1.0.0", sha256: "e".repeat(64) },
      } },
    });
    const issuedAt = new Date(Date.parse(assuranceCase.updatedAt) + 1_000).toISOString();
    const current = markContinuousAssuranceCurrent(assuranceCase.continuousAssurance!, issuedAt);
    const observedAt = new Date(Date.parse(issuedAt) + 1_000).toISOString();
    const reviewedOtherRun = applyContinuousAssuranceObservation(current, {
      observed: current.scope, trigger: "release", runStatus: "passed", runId: "reviewed-other-run", observedAt,
    }).contract;
    await store.updateAssuranceCase({
      ...assuranceCase, status: "issued", continuousAssurance: reviewedOtherRun, updatedAt: observedAt,
    }, assuranceCase.status, assuranceCase.updatedAt);

    const coverage = await service.semanticCoverage(user, projectId, 30);
    expect(coverage.evidenceStrength).toBe("recorded");
    expect(coverage.coverage.semantic).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
  });

  it("creates, renames, and isolates projects without changing stable slugs", async () => {
    const { service, projectId } = await setup();
    const created = await service.createProject(user, { name: "Browser agents" });
    const renamed = await service.renameProject(user, created.id, { name: "Browser reliability" });

    expect(created).toMatchObject({ name: "Browser agents", slug: "browser-agents" });
    expect(renamed).toMatchObject({ name: "Browser reliability", slug: "browser-agents" });
    expect((await service.projects(user)).map((project) => project.id)).toEqual([projectId, created.id]);

    const outsider: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000099", email: "outsider@example.com" };
    await service.bootstrap(outsider);
    await expect(service.renameProject(outsider, created.id, { name: "Hijacked" }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
  });

  it("computes onboarding from real key use and uploaded evidence", async () => {
    const { service, store, projectId } = await setup();
    expect(await service.onboardingStatus(user, projectId)).toMatchObject({ completedSteps: 0, complete: false });

    const key = await service.createApiKey(user, projectId, { name: "Onboarding" });
    expect(await service.onboardingStatus(user, projectId)).toMatchObject({ completedSteps: 1, complete: false });

    await store.touchApiKey(key.apiKey.id, new Date().toISOString());
    expect(await service.onboardingStatus(user, projectId)).toMatchObject({ completedSteps: 2, complete: false });

    await service.uploadEvidence(user, projectId, Buffer.from("{}"), {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
    });
    expect(await service.onboardingStatus(user, projectId)).toMatchObject({ completedSteps: 3, complete: true });
  });

  it("stores bounded pilot friction without accepting arbitrary context", async () => {
    const { service, projectId } = await setup();
    const feedback = await service.submitPilotFeedback(user, projectId, {
      stage: "cli_connect", category: "authentication", outcome: "blocked", reasonCode: "invalid_api_key",
      message: "The first key belonged to another project.",
      context: { agentType: "browser", cliVersion: "0.5.1", accessToken: "must-not-be-stored" },
    });
    expect(feedback.context).toEqual({ agentType: "browser", cliVersion: "0.5.1" });
    expect(await service.listPilotFeedback(user, projectId)).toEqual([feedback]);
  });

  it("aggregates a sequential pilot funnel with timing and failure reasons", async () => {
    const { service, store, projectId } = await setup(undefined, [user.email!]);
    const keyOnly = await service.createProject(user, { name: "Key only" });
    await service.createProject(user, { name: "Created only" });

    const completeKey = await service.createApiKey(user, projectId, { name: "Complete pilot" });
    await service.createApiKey(user, keyOnly.id, { name: "Key-only pilot" });
    await store.touchApiKey(completeKey.apiKey.id, new Date().toISOString());
    await service.uploadEvidence(user, projectId, Buffer.from("{}"), {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
    });
    const assuranceCase = await service.createAssuranceCase(user, projectId, {
      name: "Continuous browser assurance",
      subject: { id: "browser-agent", name: "Browser Agent", version: "1.0.0", kind: "browser" },
      policyPackVersion: "agentcert.browser.v0.1",
      evaluationPlan: {
        requiredEvidenceKinds: ["evidence_bundle"],
        controls: [{ id: "browser-suite", title: "Browser fault suite", mode: "automated" }],
      },
      continuousAssurance: {
        scope: {
          schemaVersion: "agentcert.assurance_scope.v0.1",
          agent: { id: "browser-agent", version: "1.0.0", artifactSha256: "a".repeat(64) },
          model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
          prompt: { sha256: "b".repeat(64) },
          tools: { manifestSha256: "c".repeat(64) },
          policy: { id: "agentcert.browser.v0.1", version: "agentcert.browser.v0.1", sha256: "d".repeat(64) },
          scenarioSuite: { id: "tripwire-browser", version: "2026.07", sha256: "e".repeat(64) },
        },
      },
    });
    const firstCurrentAt = new Date(Date.now() + 1_000).toISOString();
    const issuedContract = markContinuousAssuranceCurrent(assuranceCase.continuousAssurance!, firstCurrentAt);
    const activatedContract = {
      ...issuedContract,
      adoption: {
        schemaVersion: "agentcert.continuous_assurance_adoption.v0.1" as const,
        activatedAt: firstCurrentAt, activatedBy: user.userId, workflowSha256: "f".repeat(64),
      },
    };
    const operationalCurrent = applyContinuousAssuranceObservation(activatedContract, {
      observed: activatedContract.scope, trigger: "release", runStatus: "passed", runId: "first-hosted-release",
      observedAt: new Date(Date.parse(firstCurrentAt) + 1_000).toISOString(),
    }).contract;
    await store.updateAssuranceCase({
      ...assuranceCase,
      continuousAssurance: operationalCurrent,
      updatedAt: firstCurrentAt,
    }, assuranceCase.status, assuranceCase.updatedAt);
    await service.submitPilotFeedback(user, keyOnly.id, {
      stage: "cli_connect", category: "authentication", outcome: "blocked", reasonCode: "invalid_api_key",
    });

    const report = await service.pilotFunnelReport(user, 30);
    expect(report.stages.map((stage) => [stage.id, stage.count])).toEqual([
      ["project_created", 3], ["key_created", 2], ["cli_connected", 1], ["first_evidence", 1], ["first_current", 1],
    ]);
    expect(report.timing).toMatchObject({ medianInstallToCurrentMs: expect.any(Number), medianProjectToCurrentMs: expect.any(Number) });
    expect(report.feedback).toMatchObject({ total: 1, friction: 1, topReasons: [{ reasonCode: "invalid_api_key", count: 1 }] });
    expect(report.projects.find((project) => project.projectId === projectId)).toMatchObject({
      stage: "first_current", installToCurrentMs: expect.any(Number), totalDurationMs: expect.any(Number),
    });
    await expect(service.pilotFunnelReport(user, 14)).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 422, code: "invalid_pilot_period" });
  });

  it("keeps cross-project pilot reports platform-admin only", async () => {
    const { service } = await setup();
    await expect(service.pilotFunnelReport(user, 30)).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
  });

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
    const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const bundle = Buffer.from(JSON.stringify({
      artifacts: { screenshot: "screenshots/step.png" },
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{
          path: "screenshots/step.png",
          sha256: createHash("sha256").update(screenshot).digest("hex"),
          sizeBytes: screenshot.length,
          kind: "screenshot",
        }],
      },
    }));
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

    await service.uploadEvidence(user, projectId, screenshot, {
      fileName: "step.png", contentType: "image/png", kind: "screenshot",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id, sourcePath: "screenshots/step.png",
    });
    expect((await service.runAnalysis(user, projectId, run.id)).evidenceCompleteness).toMatchObject({
      status: "complete", evidenceCount: 2,
      reconciliation: { declared: 1, matched: 1, missing: [], mismatched: [], unexpected: [], legacy: false },
    });

    await expect(service.uploadEvidence(user, projectId, Buffer.from("MZpayload"), {
      fileName: "hostile.json", contentType: "application/json", kind: "trace",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 415 });
    const rejected = await service.runAnalysis(user, projectId, run.id);
    expect(rejected.evidenceCompleteness.status).toBe("rejected");
    expect(rejected.evidenceCompleteness.reasons[0]).toContain("Executable files");
  });

  it("rejects companion bytes and paths that do not match the bundle manifest", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "manifest-rejection", kind: "tripwire" });
    const expected = Buffer.from('{"step":1}');
    await service.uploadEvidence(user, projectId, Buffer.from(JSON.stringify({
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{
          path: "trace.json",
          sha256: createHash("sha256").update(expected).digest("hex"),
          sizeBytes: expected.length,
          kind: "trace",
        }],
      },
    })), {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    });

    await expect(service.uploadEvidence(user, projectId, Buffer.from('{"step":2}'), {
      fileName: "trace.json", contentType: "application/json", kind: "trace",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id, sourcePath: "trace.json",
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 422 });
    await expect(service.uploadEvidence(user, projectId, expected, {
      fileName: "other.json", contentType: "application/json", kind: "trace",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id, sourcePath: "other.json",
    })).rejects.toThrow("not declared");
    expect(await service.listEvidence(user, projectId)).toHaveLength(1);
    expect((await service.runAnalysis(user, projectId, run.id)).evidenceCompleteness.status).toBe("rejected");
  });

  it("reconciles identical artifact bytes declared at different paths", async () => {
    const { service, projectId } = await setup();
    const run = await service.startRun(user, projectId, { externalId: "duplicate-bytes", kind: "tripwire" });
    const bytes = Buffer.from('{"same":true}');
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await service.uploadEvidence(user, projectId, Buffer.from(JSON.stringify({
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: ["first.json", "second.json"].map((path) => ({ path, sha256, sizeBytes: bytes.length, kind: "trace" })),
      },
    })), {
      fileName: "agentcert-evidence.json", contentType: "application/json", kind: "evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1", runId: run.id,
    });
    for (const sourcePath of ["first.json", "second.json"]) {
      await service.uploadEvidence(user, projectId, bytes, {
        fileName: sourcePath, contentType: "application/json", kind: "trace",
        schemaVersion: "agentcert.evidence.v0.1", runId: run.id, sourcePath,
      });
    }
    const analysis = await service.runAnalysis(user, projectId, run.id);
    expect(analysis.evidence).toHaveLength(3);
    expect(new Set(analysis.evidence.map((item) => item.objectKey)).size).toBe(3);
    expect(analysis.evidenceCompleteness).toMatchObject({
      status: "complete", reconciliation: { declared: 2, matched: 2 },
    });
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

  it("requires a reviewed legal hold before exempting a project from 90-day cleanup", async () => {
    const { service, store, artifacts, projectId } = await setup(undefined, ["platform@example.com"]);
    const platformAdmin: AuthContext = {
      kind: "user", userId: "00000000-0000-4000-8000-000000000002", email: "platform@example.com",
    };
    const pendingEvidence = evidenceRecord(projectId, "pending", "2025-01-01T00:00:00.000Z");
    await store.insertEvidence(pendingEvidence);
    await artifacts.put(pendingEvidence.objectKey, Buffer.from("{}"), pendingEvidence.contentType);

    const request = await service.requestLegalHold(user, projectId, {
      reason: "Preserve evidence for an active enterprise legal matter.",
    });
    expect(request.status).toBe("requested");
    expect((await service.overview(user, projectId)).storage.legalHold).toMatchObject({ status: "requested" });
    expect(await service.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"))).toMatchObject({ deleted: 1 });

    await expect(service.reviewLegalHold(user, request.id, "approve", { reviewNote: "Enterprise contract confirmed." }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
    await expect(service.reviewLegalHold({ ...platformAdmin, userId: user.userId }, request.id, "approve", {
      reviewNote: "Enterprise contract confirmed.",
    })).rejects.toThrow("cannot be approved by its requester");

    const approved = await service.reviewLegalHold(platformAdmin, request.id, "approve", {
      reviewNote: "Enterprise eligibility and legal scope confirmed.",
    });
    expect(approved.status).toBe("approved");
    const heldEvidence = evidenceRecord(projectId, "held", "2025-01-02T00:00:00.000Z");
    await store.insertEvidence(heldEvidence);
    await artifacts.put(heldEvidence.objectKey, Buffer.from("{}"), heldEvidence.contentType);
    expect(await service.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"))).toMatchObject({ scanned: 0, deleted: 0 });
    expect((await service.runAnalysis(user, projectId, (await service.startRun(user, projectId, { externalId: "held-run", kind: "custom" })).id)).evidenceCompleteness)
      .toMatchObject({ legalHoldActive: true, expiresAt: undefined });

    const released = await service.reviewLegalHold(platformAdmin, request.id, "release", {
      reviewNote: "Legal matter closed; normal retention resumes.",
    });
    expect(released).toMatchObject({
      status: "released",
      reviewNote: "Enterprise eligibility and legal scope confirmed.",
      releaseNote: "Legal matter closed; normal retention resumes.",
    });
    expect(await service.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"))).toMatchObject({ deleted: 1 });
  });

  it("serializes legal hold approval with an in-progress retention deletion", async () => {
    let markDeleteStarted = (): void => undefined;
    let allowDelete = (): void => undefined;
    const deleteStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
    const deleteAllowed = new Promise<void>((resolve) => { allowDelete = resolve; });
    class BlockingDeleteStore extends MemoryArtifactStore {
      override async delete(objectKey: string): Promise<void> {
        markDeleteStarted();
        await deleteAllowed;
        await super.delete(objectKey);
      }
    }

    const store = new InMemoryControlPlaneStore();
    const artifacts = new BlockingDeleteStore();
    const service = new AgentCertControlPlane(store, artifacts, undefined, ["platform@example.com"]);
    const projectId = (await service.bootstrap(user)).project.id;
    const evidence = evidenceRecord(projectId, "legal-hold-race", "2025-01-01T00:00:00.000Z");
    await store.insertEvidence(evidence);
    await artifacts.put(evidence.objectKey, Buffer.from("{}"), evidence.contentType);
    const request = await service.requestLegalHold(user, projectId, {
      reason: "Preserve evidence for an active enterprise legal matter.",
    });

    const cleanup = service.cleanupExpiredEvidence(new Date("2026-01-01T00:00:00.000Z"));
    await deleteStarted;
    let approvalSettled = false;
    const approval = service.reviewLegalHold({
      kind: "user", userId: "00000000-0000-4000-8000-000000000002", email: "platform@example.com",
    }, request.id, "approve", {
      reviewNote: "Enterprise eligibility and legal scope confirmed.",
    }).finally(() => { approvalSettled = true; });
    await Promise.resolve();
    expect(approvalSettled).toBe(false);

    allowDelete();
    expect(await cleanup).toMatchObject({ deleted: 1 });
    expect(await approval).toMatchObject({ status: "approved" });
  });

  it("allows only one concurrent legal hold decision to commit", async () => {
    const { service, projectId } = await setup(undefined, ["first@example.com", "second@example.com"]);
    const request = await service.requestLegalHold(user, projectId, {
      reason: "Preserve evidence while an enterprise legal review is active.",
    });
    const decisions = await Promise.allSettled([
      service.reviewLegalHold({
        kind: "user", userId: "00000000-0000-4000-8000-000000000002", email: "first@example.com",
      }, request.id, "approve", { reviewNote: "Enterprise eligibility was confirmed." }),
      service.reviewLegalHold({
        kind: "user", userId: "00000000-0000-4000-8000-000000000003", email: "second@example.com",
      }, request.id, "reject", { reviewNote: "Enterprise eligibility was not confirmed." }),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = decisions.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ status: 409 });
  });

  it("allows only project owners or admins to apply for a legal hold", async () => {
    const { service, projectId } = await setup();
    await expect(service.requestLegalHold({ kind: "api_key", projectId }, projectId, {
      reason: "Preserve this enterprise evidence for active litigation.",
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
    await expect(service.requestLegalHold(user, projectId, { reason: "too short" }))
      .rejects.toThrow("20 to 2000");
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
