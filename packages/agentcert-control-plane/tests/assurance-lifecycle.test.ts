import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { verifyCanonicalAttestation } from "../src/signing.js";
import { EvidenceSigner } from "../src/signing.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const owner: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

function signer(): EvidenceSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new EvidenceSigner("assurance-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const evidenceSigner = signer();
  const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], evidenceSigner);
  const projectId = (await service.bootstrap(owner)).project.id;
  return { store, service, evidenceSigner, projectId };
}

const caseInput = {
  name: "Browser release assessment",
  subject: { id: "browser-agent", name: "Browser Agent", version: "1.0.0", kind: "browser" },
  policyPackVersion: "agentcert.browser.v0.1",
  evaluationPlan: {
    requiredEvidenceKinds: ["evidence_bundle"],
    controls: [{ id: "adversarial-suite", title: "Adversarial browser suite", mode: "automated" }],
    limitations: ["Synthetic fault environment only."],
  },
};

describe("Assurance Case lifecycle v0.1", () => {
  it("locks the evaluation plan, requires declared evidence, and prevents self-issuance", async () => {
    const { service, projectId } = await setup();
    const created = await service.createAssuranceCase(owner, projectId, caseInput);
    expect(created).toMatchObject({ status: "draft", evaluationPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Evaluation started." });
    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Ready." }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 422, code: "assurance_evidence_incomplete" });

    const evidence = await service.uploadEvidence(owner, projectId, Buffer.from("{}"), {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1",
    });
    await service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Evidence complete.", evidenceIds: [evidence.id] });
    await expect(service.transitionAssuranceCase(owner, projectId, created.id, "issue", { reason: "Issue report." }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "assurance_reviewer_separation_required" });
  });

  it("issues a signed report through a separate reviewer and exposes only explicitly published reports", async () => {
    const { store, service, evidenceSigner, projectId } = await setup();
    const evidence = await service.uploadEvidence(owner, projectId, Buffer.from("{}"), {
      fileName: "evidence.json", contentType: "application/json", kind: "evidence_bundle", schemaVersion: "agentcert.evidence.v0.1",
    });
    const created = await service.createAssuranceCase(owner, projectId, caseInput);
    await service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Started." });
    await service.transitionAssuranceCase(owner, projectId, created.id, "submit", { reason: "Submitted.", evidenceIds: [evidence.id] });
    const stored = (await store.getAssuranceCase(projectId, created.id))!;
    await store.updateAssuranceCase({ ...stored, createdBy: "independent-creator" }, stored.status);

    const issued = await service.transitionAssuranceCase(owner, projectId, created.id, "issue", { reason: "Independent review passed.", publish: true });
    const report = issued.assuranceCase.report!;
    const { attestation, ...payload } = report;
    expect(attestation && verifyCanonicalAttestation(payload, attestation, evidenceSigner.publicKeyPem)).toBe(true);
    expect(issued.assuranceCase.publicVerificationId).toBeTruthy();
    await expect(service.publicAssuranceReport("not-published")).rejects.toMatchObject({ status: 404 });
    await expect(service.publicAssuranceReport(issued.assuranceCase.publicVerificationId!)).resolves.toMatchObject({ status: "issued", report: { decision: "issued" } });
  });

  it("commits only one concurrent transition and keeps one immutable decision", async () => {
    const { store, service, projectId } = await setup();
    const created = await service.createAssuranceCase(owner, projectId, caseInput);
    const results = await Promise.allSettled([
      service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Worker A." }),
      service.transitionAssuranceCase(owner, projectId, created.id, "start", { reason: "Worker B." }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    const decisions = await store.listAssuranceCaseDecisions(projectId, created.id);
    expect(decisions.map((item) => item.toStatus)).toEqual(["draft", "evaluating"]);
  });

  it("turns an elapsed issued report into an auditable expired state on access", async () => {
    const { store, service, projectId } = await setup();
    const created = await service.createAssuranceCase(owner, projectId, caseInput);
    const expired = { ...created, status: "issued" as const, expiresAt: "2026-01-01T00:00:00.000Z", publicVerificationId: "expired-public", updatedAt: "2026-01-01T00:00:00.000Z",
      report: { schemaVersion: "agentcert.assurance_report.v0.1" as const, assuranceCaseId: created.id, projectId, subject: created.subject,
        policyPackVersion: created.policyPackVersion, evaluationPlanSha256: created.evaluationPlanSha256, evidence: [], decision: "issued" as const,
        reviewerId: "reviewer", issuedAt: "2025-12-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z", limitations: [], statement: "Expired test report." } };
    await store.updateAssuranceCase(expired, "draft");
    await expect(service.publicAssuranceReport("expired-public")).resolves.toMatchObject({ status: "expired" });
    expect((await store.listAssuranceCaseDecisions(projectId, created.id)).map((item) => item.toStatus)).toEqual(["draft", "expired"]);
  });
});
