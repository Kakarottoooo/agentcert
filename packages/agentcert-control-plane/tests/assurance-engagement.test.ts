import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { EvidenceSigner, verifyCanonicalAttestation } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const owner: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

function signer(): EvidenceSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new EvidenceSigner("delivery-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const evidenceSigner = signer();
  const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], evidenceSigner);
  const projectId = (await service.bootstrap(owner)).project.id;
  return { store, service, evidenceSigner, projectId };
}

const engagementInput = {
  name: "7-Day Browser Action Assurance Review",
  subject: { id: "browser-agent", name: "Browser Agent", version: "2.4.0", kind: "browser" },
  policyPackVersion: "agentcert.action-assurance.v0.1",
  evaluationPlan: {
    requiredEvidenceKinds: ["evidence_bundle"],
    controls: [{ id: "submit-action", title: "Authorized submit and outcome verification", mode: "evidence_required" }],
    limitations: ["One sandbox workflow only."],
  },
  engagement: {
    customer: { name: "Example Agent Company", contactEmail: "security@example.com" },
    sandbox: { name: "Procurement sandbox", kind: "synthetic" },
    workflow: {
      name: "Submit purchase order",
      description: "Submit one approved purchase order in the customer sandbox.",
      highRiskAction: "SUBMIT",
      expectedOutcome: { purchaseOrderStatus: "SUBMITTED" },
    },
  },
  continuousAssurance: {
    scope: {
      schemaVersion: "agentcert.assurance_scope.v0.1",
      agent: { id: "browser-agent", version: "2.4.0", artifactSha256: "a".repeat(64) },
      model: { provider: "openai", name: "gpt-4.1-mini", version: "2026-07-01" },
      prompt: { sha256: "b".repeat(64) },
      tools: { manifestSha256: "c".repeat(64) },
      policy: { id: "agentcert.action-assurance.v0.1", version: "agentcert.action-assurance.v0.1", sha256: "d".repeat(64) },
      scenarioSuite: { id: "tripwire-browser", version: "2026.07", sha256: "e".repeat(64) },
    },
  },
};

async function upload(service: AgentCertControlPlane, projectId: string, name: string) {
  return service.uploadEvidence(owner, projectId, Buffer.from(JSON.stringify({ name })), {
    fileName: `${name}.json`, contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1",
  });
}

describe("7-Day Assurance Review engagement", () => {
  it("locks the seven-day scope and fixed commercial terms at creation", async () => {
    const { service, projectId } = await setup();
    const created = await service.createAssuranceCase(owner, projectId, engagementInput);
    expect(created.engagement).toMatchObject({
      schemaVersion: "agentcert.assurance_engagement.v0.1",
      customer: { name: "Example Agent Company" },
      terms: { priceUsd: 5000, workflowCount: 1, includedRetests: 1, privacy: "private_by_default" },
      remediationItems: [],
    });
    expect(Date.parse(created.engagement!.dueAt) - Date.parse(created.engagement!.planLockedAt)).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(created.evaluationPlanSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records one immutable baseline and one distinct retest", async () => {
    const { service, projectId } = await setup();
    const baseline = await upload(service, projectId, "baseline");
    const retest = await upload(service, projectId, "retest");
    const created = await service.createAssuranceCase(owner, projectId, engagementInput);
    const digest = created.evaluationPlanSha256;
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Start review." });
    const recorded = await service.transitionAssuranceCase(owner, projectId, created.id, "baseline", { evidenceIds: [baseline.id] });
    expect(recorded.assuranceCase.engagement).toMatchObject({ firstEvidenceAt: expect.any(String), timeToFirstEvidenceSeconds: expect.any(Number) });
    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "baseline", { evidenceIds: [retest.id] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "assurance_baseline_locked" });
    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "retest", { evidenceIds: [baseline.id] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 422, code: "assurance_retest_evidence_reused" });
    const completed = await service.transitionAssuranceCase(owner, projectId, created.id, "retest", { evidenceIds: [retest.id] });
    expect(completed.assuranceCase.evaluationPlanSha256).toBe(digest);
    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "retest", { evidenceIds: [retest.id] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "assurance_retest_locked" });
  });

  it("commits only one concurrent baseline append", async () => {
    const { store, service, projectId } = await setup();
    const first = await upload(service, projectId, "baseline-a");
    const second = await upload(service, projectId, "baseline-b");
    const created = await service.createAssuranceCase(owner, projectId, engagementInput);
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Start review." });
    const results = await Promise.allSettled([
      service.transitionAssuranceCase(owner, projectId, created.id, "baseline", { evidenceIds: [first.id] }),
      service.transitionAssuranceCase(owner, projectId, created.id, "baseline", { evidenceIds: [second.id] }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await store.getAssuranceCase(projectId, created.id))?.engagement?.baseline?.evidenceIds).toHaveLength(1);
  });

  it("enforces the three-state decision contract and produces a signed delivery packet", async () => {
    const { store, service, evidenceSigner, projectId } = await setup();
    const baseline = await upload(service, projectId, "baseline");
    const retest = await upload(service, projectId, "retest");
    const created = await service.createAssuranceCase(owner, projectId, engagementInput);
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Start review." });
    await service.transitionAssuranceCase(owner, projectId, created.id, "baseline", { evidenceIds: [baseline.id] });
    await service.transitionAssuranceCase(owner, projectId, created.id, "remediation", { items: [{ title: "Require approval before SUBMIT", status: "addressed", evidenceIds: [retest.id] }] });
    await service.transitionAssuranceCase(owner, projectId, created.id, "retest", { evidenceIds: [retest.id] });
    await service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Independent review requested." });
    const stored = (await store.getAssuranceCase(projectId, created.id))!;
    await store.updateAssuranceCase({ ...stored, createdBy: "independent-creator" }, stored.status);

    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "issue", {
      reason: "Release requested.", verdict: "RELEASE", rationale: "All declared controls passed.", firstDivergence: "No divergence observed.",
      outcome: { observed: { purchaseOrderStatus: "DRAFT" }, verified: false }, limitations: ["Sandbox only."],
    })).rejects.toMatchObject<Partial<ControlPlaneError>>({ code: "assurance_release_unverified" });

    const issued = await service.transitionAssuranceCase(owner, projectId, created.id, "issue", {
      reason: "Issue controlled release decision.", verdict: "RELEASE_WITH_CONTROLS", rationale: "The retest passed with an enforced approval gate.",
      firstDivergence: "Baseline attempted SUBMIT before approval.", authorizationGaps: ["Baseline did not bind approval to the action mandate."],
      outcome: { observed: { purchaseOrderStatus: "SUBMITTED" }, verified: true }, controlsRequired: ["Keep the approval gateway mandatory."],
      limitations: ["One sandbox workflow and one agent version were assessed."], publish: true,
    });
    expect(issued.assuranceCase.engagement?.decision?.verdict).toBe("RELEASE_WITH_CONTROLS");
    const packet = issued.assuranceCase.deliveryPacket!;
    expect(packet).toMatchObject({
      schemaVersion: "agentcert.assurance_delivery.v0.1", decision: { verdict: "RELEASE_WITH_CONTROLS" },
      baselineEvidence: [{ id: baseline.id }], retestEvidence: [{ id: retest.id }],
      continuousAssurance: { freshnessAtIssuance: "CURRENT", ciPolicy: { pullRequest: "prospective", release: "authoritative", nightly: "authoritative" } },
    });
    const { attestation, ...payload } = packet;
    expect(verifyCanonicalAttestation(payload, attestation, evidenceSigner.publicKeyPem)).toBe(true);
    const activated = await service.transitionAssuranceCase(owner, projectId, created.id, "activate-continuous", {});
    expect(activated).toMatchObject({
      assuranceCase: { continuousAssurance: { adoption: { schemaVersion: "agentcert.continuous_assurance_adoption.v0.1" } } },
      kit: { schemaVersion: "agentcert.continuous_assurance_kit.v0.1" },
    });
    expect(activated.kit.files.map((file) => file.path)).toEqual([
      "agentcert.assurance-scope.json",
      ".github/workflows/agentcert-continuous-assurance.yml",
      "AGENTCERT-CONTINUOUS-ASSURANCE.md",
    ]);
    expect(activated.kit.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    const workflow = activated.kit.files.find((file) => file.path.endsWith(".yml"))?.content ?? "";
    expect(workflow).toContain("secrets.AGENTCERT_API_KEY");
    expect(workflow).toContain("pull-request-config: tripwire.yml");
    expect(workflow).toContain("release-config: tripwire.yml");
    expect(workflow).toContain("nightly-config: tripwire.yml");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect((await service.transitionAssuranceCase(owner, projectId, created.id, "activate-continuous", {})).kit).toEqual(activated.kit);

    const changedScope = structuredClone(engagementInput.continuousAssurance.scope);
    changedScope.model.version = "2026-07-18";
    const releaseRun = await service.startRun(owner, projectId, {
      externalId: "release-requiring-revalidation", kind: "release_gate",
      assurance: { caseId: created.id, trigger: "release", scope: changedScope },
    });
    await service.completeRun(owner, projectId, releaseRun.id, { status: "passed" });
    const successor = (await service.transitionAssuranceCase(owner, projectId, created.id, "revalidate", {})).assuranceCase;
    const successorEvidence = await upload(service, projectId, "successor-revalidation");
    await service.transitionAssuranceCase(owner, projectId, successor.id, "start", { reason: "Start successor review." });
    await service.transitionAssuranceCase(owner, projectId, successor.id, "submit", {
      reason: "Submit successor evidence.", evidenceIds: [successorEvidence.id],
    });
    const successorReview = (await store.getAssuranceCase(projectId, successor.id))!;
    await store.updateAssuranceCase({ ...successorReview, createdBy: "independent-successor-creator" }, successorReview.status);
    await service.transitionAssuranceCase(owner, projectId, successor.id, "issue", { reason: "Issue successor review." });
    const successorActivation = await service.transitionAssuranceCase(owner, projectId, successor.id, "activate-continuous", {});
    expect(successorActivation.kit.assuranceCaseId).toBe(successor.id);
    expect(successorActivation.kit.files.find((file) => file.path.endsWith(".yml"))?.content).toContain(`assurance-case: ${successor.id}`);
    await expect(service.publicAssuranceReport(issued.assuranceCase.publicVerificationId!)).resolves.toMatchObject({ deliveryPacket: { schemaVersion: "agentcert.assurance_delivery.v0.1" } });
  });
});
