import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import {
  applyContinuousAssuranceObservation,
  assuranceScopeFingerprint,
  buildContinuousAssuranceAdoptionKit,
  compareAssuranceScopes,
  createContinuousAssuranceContract,
  createContinuousAssuranceRevalidation,
  markContinuousAssuranceCurrent,
  reconcileContinuousAssurance,
  type AssuranceScopeInput,
} from "../src/continuous-assurance.js";
import type { EmailMessage, EmailProvider } from "../src/notifications.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AssuranceCaseRecord, AuthContext, NotificationJobRecord } from "../src/types.js";

const owner: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

const scope: AssuranceScopeInput = {
  schemaVersion: "agentcert.assurance_scope.v0.1",
  agent: { id: "browser-agent", version: "2.4.0", artifactSha256: "a".repeat(64) },
  model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
  prompt: { sha256: "b".repeat(64) },
  tools: { manifestSha256: "c".repeat(64) },
  policy: { id: "agentcert.action-assurance", version: "0.1.0", sha256: "d".repeat(64) },
  scenarioSuite: { id: "tripwire-browser", version: "2026.07", sha256: "e".repeat(64) },
};

describe("continuous assurance scope", () => {
  it("produces one deterministic fingerprint from canonical scope data", () => {
    const reordered = {
      scenarioSuite: { sha256: "e".repeat(64), version: "2026.07", id: "tripwire-browser" },
      policy: { sha256: "d".repeat(64), version: "0.1.0", id: "agentcert.action-assurance" },
      tools: { manifestSha256: "c".repeat(64) },
      prompt: { sha256: "b".repeat(64) },
      model: { version: "2026-07-01", name: "gpt-4.1-mini", provider: "openai" },
      agent: { artifactSha256: "a".repeat(64), version: "2.4.0", id: "browser-agent" },
      schemaVersion: "agentcert.assurance_scope.v0.1",
    } satisfies AssuranceScopeInput;

    expect(assuranceScopeFingerprint(scope)).toBe("7772847c6726f31e4041288f4d35943b21c1bdc5944e162a115ad9a0327c67df");
    expect(assuranceScopeFingerprint(reordered)).toBe(assuranceScopeFingerprint(scope));
  });

  it("identifies exactly which declared components changed", () => {
    const observed: AssuranceScopeInput = {
      ...scope,
      model: { ...scope.model, version: "2026-07-15" },
      prompt: { sha256: "f".repeat(64) },
    };

    expect(compareAssuranceScopes(scope, observed).map((change) => change.component)).toEqual(["model", "prompt"]);
  });

  it("keeps pull-request drift prospective but invalidates on release or nightly drift", () => {
    const changed = { ...scope, tools: { manifestSha256: "f".repeat(64) } };
    const pullRequest = reconcileContinuousAssurance({ baseline: scope, observed: changed, trigger: "pull_request", runStatus: "passed" });
    expect(pullRequest).toMatchObject({ outcome: "would_require_revalidation", authoritative: false, nextStatus: "CURRENT" });

    const release = reconcileContinuousAssurance({ baseline: scope, observed: changed, trigger: "release", runStatus: "passed" });
    expect(release).toMatchObject({ outcome: "revalidation_required", authoritative: true, nextStatus: "REVALIDATION_REQUIRED" });

    const nightlyFailure = reconcileContinuousAssurance({ baseline: scope, observed: scope, trigger: "nightly", runStatus: "failed" });
    expect(nightlyFailure).toMatchObject({ outcome: "revalidation_required", nextStatus: "REVALIDATION_REQUIRED", reasonCode: "evaluation_failed" });
  });

  it("generates a deterministic secret-free CI kit and carries revalidation cycle metrics forward", () => {
    const issuedAt = "2026-07-17T00:00:00.000Z";
    const baseline = markContinuousAssuranceCurrent(createContinuousAssuranceContract(scope, issuedAt), issuedAt);
    const first = buildContinuousAssuranceAdoptionKit({
      contract: baseline, projectId: "project-1", assuranceCaseId: "case-1", generatedAt: issuedAt,
    });
    const second = buildContinuousAssuranceAdoptionKit({
      contract: baseline, projectId: "project-1", assuranceCaseId: "case-1", generatedAt: issuedAt,
    });
    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([
      "agentcert.assurance-scope.json",
      ".github/workflows/agentcert-continuous-assurance.yml",
      "AGENTCERT-CONTINUOUS-ASSURANCE.md",
    ]);
    const workflow = first.files.find((file) => file.path.endsWith(".yml"))!.content;
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("assurance-trigger: auto");
    expect(workflow).toContain("require-current: auto");
    expect(workflow).toContain("continuous-assurance-health.json");
    expect(workflow).toContain("agentcert.generated_kit_health.v0.1");
    expect(workflow).toContain("agentcert-generated-kit-health");
    expect(workflow).toContain("publicHealth.status !== 'CURRENT'");
    expect(workflow).toContain("${{ secrets.AGENTCERT_API_KEY }}");
    expect(workflow).not.toMatch(/ac_(?:live|test)_/);

    const changed = { ...scope, model: { ...scope.model, version: "2026-07-18" } };
    const revalidation = createContinuousAssuranceRevalidation(baseline, changed, "2026-07-18T00:00:00.000Z", "case-1");
    const current = markContinuousAssuranceCurrent(revalidation, "2026-07-18T02:00:00.000Z");
    expect(current).toMatchObject({
      firstCurrentAt: issuedAt,
      revalidation: { cycleNumber: 1, sourceCaseId: "case-1", durationMs: 7_200_000 },
      metrics: {
        revalidationStartedCount: 1,
        revalidationCompletedCount: 1,
        totalRevalidationDurationMs: 7_200_000,
        lastRevalidationDurationMs: 7_200_000,
      },
    });
    expect(current.history?.map((event) => event.kind)).toEqual(expect.arrayContaining(["contract_created", "current", "revalidation_started"]));
  });

  it("measures first CURRENT from kit activation only after an authoritative Hosted run", () => {
    const issuedAt = "2026-07-18T00:00:00.000Z";
    const activatedAt = "2026-07-18T00:02:00.000Z";
    const baseline = markContinuousAssuranceCurrent(createContinuousAssuranceContract(scope, issuedAt), issuedAt);
    const adopted = {
      ...baseline,
      adoption: {
        schemaVersion: "agentcert.continuous_assurance_adoption.v0.1" as const,
        activatedAt, activatedBy: owner.userId, workflowSha256: "f".repeat(64),
      },
    };
    const prospective = applyContinuousAssuranceObservation(adopted, {
      observed: scope, trigger: "pull_request", runStatus: "passed", runId: "pr-1", observedAt: "2026-07-18T00:03:00.000Z",
    }).contract;
    expect(prospective.adoption?.firstAuthoritativeCurrentAt).toBeUndefined();

    const release = applyContinuousAssuranceObservation(prospective, {
      observed: scope, trigger: "release", runStatus: "passed", runId: "release-1", observedAt: "2026-07-18T00:07:00.000Z",
    }).contract;
    expect(release.adoption).toMatchObject({
      firstAuthoritativeCurrentAt: "2026-07-18T00:07:00.000Z",
      firstAuthoritativeRunId: "release-1",
      timeToFirstCurrentMs: 300_000,
    });
    const nightly = applyContinuousAssuranceObservation(release, {
      observed: scope, trigger: "nightly", runStatus: "passed", runId: "nightly-1", observedAt: "2026-07-19T00:00:00.000Z",
    }).contract;
    expect(nightly.adoption?.firstAuthoritativeRunId).toBe("release-1");
  });

  it("queues each expiry threshold once and expires the case through scheduled maintenance", async () => {
    const store = new FailOnceNotificationStore();
    const email = new RecordingEmailProvider();
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new EvidenceSigner("expiry-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], signer, undefined, fetch, email, "https://agentcert.app",
    );
    const projectId = (await service.bootstrap(owner)).project.id;
    await service.createNotificationDestination(owner, projectId, {
      email: "security@example.com", alertTypes: ["assurance_expiry_warning", "assurance_expired"],
    });
    await service.processNotificationJobs("verification-worker");
    const token = new URL(email.messages[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await service.verifyNotificationDestination(token);
    const evidence = await service.uploadEvidence(owner, projectId, Buffer.from("{}"), {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1",
    });
    const created = await service.createAssuranceCase(owner, projectId, {
      name: "Expiring assurance", subject: { id: "browser-agent", name: "Browser Agent", version: "2.4.0", kind: "browser" },
      policyPackVersion: scope.policy.version,
      evaluationPlan: {
        requiredEvidenceKinds: ["evidence_bundle"],
        controls: [{ id: "fault-suite", title: "Deterministic fault suite", mode: "automated" }],
        limitations: ["Synthetic browser environment."],
      },
      continuousAssurance: { scope },
    });
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Start." });
    await service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Review.", evidenceIds: [evidence.id] });
    const reviewReady = (await store.getAssuranceCase(projectId, created.id))!;
    await store.updateAssuranceCase({ ...reviewReady, createdBy: "independent-creator" }, reviewReady.status);
    const expiresAt = new Date(Date.now() + 40 * 86_400_000);
    const issued = await service.transitionAssuranceCase(owner, projectId, created.id, "issue", {
      reason: "Issue.", expiresAt: expiresAt.toISOString(),
    });
    const reminderAt = new Date(Date.parse(issued.assuranceCase.expiresAt!) - 6 * 86_400_000);
    store.failNextNotification = true;
    expect(await service.processContinuousAssuranceMaintenance(reminderAt)).toMatchObject({ remindersQueued: 0, expired: 0, failed: 1 });
    expect((await store.getAssuranceCase(projectId, created.id))?.continuousAssurance?.reminders?.expiryThresholdDaysSent).toEqual([]);
    expect(await service.processContinuousAssuranceMaintenance(reminderAt)).toMatchObject({ remindersQueued: 1, expired: 0, failed: 0 });
    expect(await service.processContinuousAssuranceMaintenance(new Date(reminderAt.getTime() + 60_000))).toMatchObject({ remindersQueued: 0 });
    expect((await store.getAssuranceCase(projectId, created.id))?.continuousAssurance?.reminders?.expiryThresholdDaysSent).toEqual([30, 7]);
    await service.processNotificationJobs("expiry-worker");
    expect(email.messages.map((message) => message.subject)).toContain("[AgentCert] Assurance expires within 7 days: Browser Agent");

    expect(await service.processContinuousAssuranceMaintenance(new Date(expiresAt.getTime() + 1_000))).toMatchObject({ expired: 1 });
    expect((await store.getAssuranceCase(projectId, created.id))).toMatchObject({
      status: "expired", continuousAssurance: { freshness: { status: "EXPIRED" } },
    });
  });

  it("does not let already-reminded cases consume a limited maintenance batch", async () => {
    const store = new InMemoryControlPlaneStore();
    const now = "2026-07-17T00:00:00.000Z";
    const dueContract = markContinuousAssuranceCurrent(createContinuousAssuranceContract(scope, now), now);
    const alreadyReminded = structuredClone(dueContract);
    alreadyReminded.reminders = {
      expiryThresholdDaysSent: [30, 7],
      lastExpiryReminderAt: "2026-07-16T00:00:00.000Z",
    };
    const record = (id: string, expiresAt: string, continuousAssurance: typeof dueContract): AssuranceCaseRecord => ({
      id,
      projectId: "project-1",
      name: id,
      subject: { id: "browser-agent", name: "Browser Agent", version: "2.4.0", kind: "browser" },
      status: "issued",
      policyPackVersion: scope.policy.version,
      evaluationPlan: { requiredEvidenceKinds: [], controls: [], limitations: [] },
      evaluationPlanSha256: "f".repeat(64),
      evidenceIds: [],
      createdBy: owner.userId,
      continuousAssurance,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await store.insertAssuranceCase(record("already-reminded", "2026-07-22T00:00:00.000Z", alreadyReminded));
    await store.insertAssuranceCase(record("pending-reminder", "2026-07-23T00:00:00.000Z", dueContract));

    const batch = await store.listAssuranceCasesForMaintenance(now, "2026-08-16T00:00:00.000Z", 1);
    expect(batch.map((item) => item.id)).toEqual(["pending-reminder"]);
  });

  it("binds an issued baseline to PR, release, notifications, and an explicit successor revalidation", async () => {
    const store = new InMemoryControlPlaneStore();
    const email = new RecordingEmailProvider();
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new EvidenceSigner("continuous-assurance-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const service = new AgentCertControlPlane(
      store, new MemoryArtifactStore(), undefined, [], signer, undefined, fetch, email, "https://agentcert.app",
    );
    const projectId = (await service.bootstrap(owner)).project.id;
    const destination = await service.createNotificationDestination(owner, projectId, {
      email: "security@example.com",
      alertTypes: ["assurance_current", "assurance_revalidation_required"],
    });
    await service.processNotificationJobs("verification-worker");
    const token = new URL(email.messages[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await service.verifyNotificationDestination(token);

    const evidence = await service.uploadEvidence(owner, projectId, Buffer.from("{}"), {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1",
    });
    const created = await service.createAssuranceCase(owner, projectId, {
      name: "Browser release assurance",
      subject: { id: "browser-agent", name: "Browser Agent", version: scope.agent.version, kind: "browser" },
      policyPackVersion: scope.policy.version,
      evaluationPlan: {
        requiredEvidenceKinds: ["evidence_bundle"],
        controls: [{ id: "fault-suite", title: "Deterministic fault suite", mode: "automated" }],
        limitations: ["Synthetic browser environment."],
      },
      continuousAssurance: { scope },
    });
    expect(created.continuousAssurance).toMatchObject({ freshness: { status: "REVALIDATION_REQUIRED" } });
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Evaluation started." });
    await service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Evidence is ready for independent review.", evidenceIds: [evidence.id] });
    const reviewReady = (await store.getAssuranceCase(projectId, created.id))!;
    await store.updateAssuranceCase({ ...reviewReady, createdBy: "independent-creator" }, reviewReady.status);
    const issued = await service.transitionAssuranceCase(owner, projectId, created.id, "issue", {
      reason: "Independent review passed for the declared scope.",
    });
    expect(issued.assuranceCase.continuousAssurance).toMatchObject({ freshness: { status: "CURRENT" } });
    expect(issued.assuranceCase.report?.continuousAssurance).toMatchObject({
      scopeFingerprintSha256: assuranceScopeFingerprint(scope), freshnessAtIssuance: "CURRENT",
    });

    const changed = { ...scope, model: { ...scope.model, version: "2026-07-15" } };
    const pullRequest = await service.startRun(owner, projectId, {
      externalId: "pr-42", kind: "release_gate", assurance: { caseId: created.id, trigger: "pull_request", scope: changed },
    });
    await expect(service.startRun(owner, projectId, {
      externalId: "pr-42", kind: "release_gate", assurance: { caseId: created.id, trigger: "release", scope: changed },
    })).rejects.toMatchObject({ status: 409, code: "run_external_id_conflict" });
    const completedPullRequest = await service.completeRun(owner, projectId, pullRequest.id, { status: "passed" });
    expect(completedPullRequest.metadata.continuousAssurance).toMatchObject({
      reconciliation: { outcome: "would_require_revalidation", authoritative: false, changedComponents: ["model"] },
    });
    expect((await store.getAssuranceCase(projectId, created.id))?.continuousAssurance).toMatchObject({
      freshness: { status: "CURRENT" }, prospective: { runId: pullRequest.id, outcome: "would_require_revalidation" },
    });

    const release = await service.startRun(owner, projectId, {
      externalId: "release-2.5.0", kind: "release_gate", assurance: { caseId: created.id, trigger: "release", scope: changed },
    });
    await Promise.all([
      service.completeRun(owner, projectId, release.id, { status: "passed" }),
      service.completeRun(owner, projectId, release.id, { status: "passed" }),
    ]);
    const invalidated = (await store.getAssuranceCase(projectId, created.id))!;
    expect(invalidated.continuousAssurance).toMatchObject({
      freshness: { status: "REVALIDATION_REQUIRED", reasonCode: "scope_changed", changedComponents: [{ component: "model" }] },
      metrics: { totalEvaluations: 2, passedEvaluations: 2, prospectiveChangeCount: 1, revalidationRequiredCount: 1 },
    });
    expect(invalidated.report?.continuousAssurance).toMatchObject({ freshnessAtIssuance: "CURRENT" });

    const completedRelease = (await store.getRun(projectId, release.id))!;
    await store.upsertRun({
      ...completedRelease,
      metadata: { continuousAssurance: {
        schemaVersion: "agentcert.run_assurance.v0.1", caseId: created.id, trigger: "release",
        scope: changed, scopeFingerprintSha256: assuranceScopeFingerprint(changed),
      } },
    });
    const recoveredRelease = await service.completeRun(owner, projectId, release.id, { status: "passed" });
    expect(recoveredRelease.metadata.continuousAssurance).toMatchObject({ reconciliation: {
      outcome: "revalidation_required", changedComponents: ["model"],
    } });
    expect((await store.getAssuranceCase(projectId, created.id))?.continuousAssurance?.metrics.totalEvaluations).toBe(2);

    const revalidation = await service.transitionAssuranceCase(owner, projectId, created.id, "revalidate", {});
    expect(revalidation.assuranceCase).toMatchObject({
      status: "draft",
      subject: { version: changed.agent.version },
      continuousAssurance: { supersedesCaseId: created.id, scope: changed, freshness: { status: "REVALIDATION_REQUIRED" } },
    });
    expect((await service.transitionAssuranceCase(owner, projectId, created.id, "revalidate", {})).assuranceCase.id).toBe(revalidation.assuranceCase.id);
    expect(destination.status).toBe("pending_verification");
    await service.processNotificationJobs("assurance-worker");
    expect(email.messages.map((message) => message.subject)).toEqual(expect.arrayContaining([
      expect.stringContaining("Assurance current"),
      expect.stringContaining("Assurance revalidation required"),
    ]));
  });
});

class RecordingEmailProvider implements EmailProvider {
  readonly name = "test";
  readonly configured = true;
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { provider: this.name, messageId: `message-${this.messages.length}` };
  }
}

class FailOnceNotificationStore extends InMemoryControlPlaneStore {
  failNextNotification = false;

  override async enqueueNotificationJob(record: NotificationJobRecord): Promise<NotificationJobRecord> {
    if (this.failNextNotification) {
      this.failNextNotification = false;
      throw new Error("Synthetic notification queue failure.");
    }
    return super.enqueueNotificationJob(record);
  }
}
