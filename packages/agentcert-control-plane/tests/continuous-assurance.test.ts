import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import {
  assuranceScopeFingerprint,
  compareAssuranceScopes,
  reconcileContinuousAssurance,
  type AssuranceScopeInput,
} from "../src/continuous-assurance.js";
import type { EmailMessage, EmailProvider } from "../src/notifications.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

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
