import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentCertControlPlane,
  EvidenceSigner,
  InMemoryControlPlaneStore,
  MemoryArtifactStore,
  verifyActionAssuranceReceipt,
} from "../packages/agentcert-control-plane/dist/index.js";
import { runTrustedBrowserSubmitDemo } from "../packages/onegent-runtime/dist/trusted-browser-demo.js";

test("controlled browser sandbox evidence maps to a signed action receipt without overstating enforcement", async () => {
  const output = join(tmpdir(), `agentcert-action-assurance-${randomUUID()}`);
  const browserRun = await runTrustedBrowserSubmitDemo(join(output, "browser"));
  const auditPacketBytes = await readFile(browserRun.auditPacketPath);
  const auditPacket = JSON.parse(auditPacketBytes.toString("utf8"));

  assert.equal(browserRun.evidenceStrength, "outcome_verified");
  assert.equal(auditPacket.trustedActionEvidence.runReceipt.journal.valid, true);
  assert.equal(auditPacket.trustedActionEvidence.verification.success, true);

  const owner = { kind: "user", userId: randomUUID(), email: "browser-e2e@example.test" };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = new EvidenceSigner(
    "action-assurance-browser-e2e",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const service = new AgentCertControlPlane(
    new InMemoryControlPlaneStore(),
    new MemoryArtifactStore(),
    undefined,
    [],
    signer,
  );
  const { project } = await service.bootstrap(owner);
  const agent = await service.createAgent(owner, project.id, {
    externalId: "procurement-browser-agent",
    name: "Procurement Browser Agent",
    version: "demo-v1",
    allowedPermissions: ["MockProcurementWeb:SUBMIT"],
  });
  const mandate = await service.createActionMandate(owner, project.id, {
    granteeIdentityId: "procurement-browser-agent",
    audience: ["MockProcurementWeb"],
    permittedActionClasses: ["SUBMIT"],
    permittedOperations: ["MockProcurementWeb:SUBMIT"],
    permittedResources: ["MockProcurementWeb"],
    constraints: { monetaryLimit: 5_000, approvalRequirement: "HUMAN" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUses: 1,
  });
  const action = await service.proposeAction(owner, project.id, {
    externalId: `browser-submit-${randomUUID()}`,
    agentId: agent.id,
    principal: { id: "procurement-browser-agent", version: "demo-v1" },
    actionType: "SUBMIT",
    targetSystem: "MockProcurementWeb",
    requestedPermissions: ["MockProcurementWeb:SUBMIT"],
    amount: 4_850,
    currency: "USD",
    expectedState: { purchaseOrderId: "PO-4850", status: "SUBMITTED" },
    mandateId: mandate.id,
    requireMandate: true,
  });
  assert.equal(action.status, "PENDING_APPROVAL");

  await service.reviewAction(owner, project.id, action.id, true, {
    comment: "Browser sandbox scope and purchase order reviewed.",
  });
  await service.uploadEvidence(owner, project.id, auditPacketBytes, {
    fileName: "trusted-browser-audit-packet.json",
    contentType: "application/json",
    kind: "json",
    schemaVersion: String(auditPacket.schemaVersion ?? "onegent.audit_packet.v0.1"),
    actionId: action.id,
  });
  await service.verifyAction(owner, project.id, action.id, {
    observedState: { purchaseOrderId: "PO-4850", status: "SUBMITTED" },
    observationMethod: "TARGET_API",
    observationSource: "Onegent independent mock procurement probe",
    collectorIdentityId: "onegent-browser-demo-collector",
    confidence: 1,
  });

  const stored = await service.issueActionAssuranceReceipt(owner, project.id, action.id);
  const trustBundle = {
    [signer.keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const verification = verifyActionAssuranceReceipt(stored.receipt, trustBundle, new Date(stored.createdAt));

  assert.equal(verification.result, "VALID_WITH_WARNINGS");
  assert.equal(stored.receipt.core.enforcementLevel, "SELF_REPORTED");
  assert.equal(stored.receipt.core.evidenceStrength, "REPORTED");
  assert.ok(stored.receipt.core.warnings.includes("execution_boundary_not_verified"));
  assert.ok(stored.receipt.core.warnings.includes("outcome_provenance_unverified"));
  assert.deepEqual(stored.receipt.core.evidenceManifest.map((item) => item.kind), ["json"]);
  assert.ok(stored.receipt.core.controls.notControlled.includes("alternate_execution_paths"));
});
