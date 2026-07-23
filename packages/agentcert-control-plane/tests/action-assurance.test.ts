import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import {
  ACTION_MANDATE_VERSION,
  actionIntentDigest,
  createActionAssuranceReceipt,
  mandateDigest,
  validateDelegationAttenuation,
  validateMandateForAction,
  verifyActionAssuranceReceipt,
  type ActionMandatePayload,
  type ActionMandateRecord,
  type ActionPolicyDecisionRecord,
  type OutcomeAttestationRecord,
} from "../src/action-assurance.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { ActionRecord, AuthContext } from "../src/types.js";

const user: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };

function signer() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new EvidenceSigner("action-receipt-test-key", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

async function setup() {
  const evidenceSigner = signer();
  const service = new AgentCertControlPlane(new InMemoryControlPlaneStore(), new MemoryArtifactStore(), undefined, [], evidenceSigner, undefined, fetch, undefined, "https://agentcert.example");
  const bootstrap = await service.bootstrap(user);
  return { service, projectId: bootstrap.project.id, evidenceSigner };
}

function action(projectId = randomUUID()): ActionRecord {
  return {
    id: randomUUID(), projectId, externalId: "submit-claim-1", principal: { id: "claims-agent", version: "1.0.0" },
    actionType: "SUBMIT", targetSystem: "SandboxClaims", requestedPermissions: ["SandboxClaims:SUBMIT"], amount: 4_850, currency: "USD",
    riskLevel: "HIGH", riskScore: 85, decision: "REQUIRE_APPROVAL", status: "APPROVED", policyVersion: "agentcert.default.v1",
    reasons: ["High-value submission requires review."], expectedState: { status: "SUBMITTED" }, createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:01:00.000Z",
  };
}

function mandateFor(value: ActionRecord): ActionMandateRecord {
  const payload: ActionMandatePayload = {
    schemaVersion: ACTION_MANDATE_VERSION, mandateId: randomUUID(), tenantId: value.projectId,
    issuerIdentityId: "claims-manager", granteeIdentityId: "claims-agent", audience: ["SandboxClaims"],
    permittedActionClasses: ["SUBMIT"], permittedOperations: ["SandboxClaims:SUBMIT"], permittedResources: ["SandboxClaims"],
    prohibitedOperations: [], constraints: { monetaryLimit: 5_000, approvalRequirement: "HUMAN" },
    validFrom: "2026-07-22T00:00:00.000Z", expiresAt: "2026-08-22T00:00:00.000Z", maxUses: 1,
    maxDelegationDepth: 1, nonce: "fixture-nonce", version: 1, createdAt: "2026-07-22T00:00:00.000Z",
  };
  return { id: payload.mandateId, projectId: value.projectId, payload, digestSha256: mandateDigest(payload), status: "ACTIVE", createdBy: "claims-manager", createdAt: payload.createdAt };
}

describe("Action Assurance v0.1", () => {
  it("blocks a mandate-required action when no mandate is supplied", async () => {
    const { service, projectId } = await setup();
    const result = await service.proposeAction(user, projectId, {
      externalId: "unmandated-submit", principal: { id: "claims-agent" }, actionType: "SUBMIT", targetSystem: "SandboxClaims",
      requestedPermissions: ["SandboxClaims:SUBMIT"], requireMandate: true,
    });
    expect(result).toMatchObject({ decision: "DENY", status: "DENIED" });
    expect(result.reasons).toContain("mandate_missing");
  });

  it("reuses an identical external action ID without consuming the mandate twice", async () => {
    const { service, projectId } = await setup();
    const mandate = await service.createActionMandate(user, projectId, {
      granteeIdentityId: "claims-agent", audience: ["SandboxClaims"], permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["SandboxClaims:SUBMIT"], permittedResources: ["SandboxClaims"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxUses: 1,
    });
    const input = {
      externalId: "idempotent-claim", principal: { id: "claims-agent" }, actionType: "SUBMIT" as const,
      targetSystem: "SandboxClaims", requestedPermissions: ["SandboxClaims:SUBMIT"], mandateId: mandate.id, requireMandate: true,
    };
    const first = await service.proposeAction(user, projectId, input);
    const retry = await service.proposeAction(user, projectId, input);
    expect(retry.id).toBe(first.id);
    await expect(service.proposeAction(user, projectId, { ...input, amount: 20_000 })).rejects.toMatchObject({ status: 409, code: "action_idempotency_conflict" });
  });

  it("detects expired and revoked mandates", () => {
    const value = action();
    const mandate = mandateFor(value);
    expect(validateMandateForAction(mandate, value, new Date("2026-07-23T00:00:00.000Z"))).toEqual([]);
    expect(validateMandateForAction(mandate, value, new Date("2026-09-01T00:00:00.000Z"))).toContain("mandate_not_active");
    expect(validateMandateForAction({ ...mandate, status: "REVOKED" }, value, new Date("2026-07-23T00:00:00.000Z"))).toContain("mandate_revoked");
  });

  it("persists mandate revocation and blocks subsequent action use", async () => {
    const { service, projectId } = await setup();
    const mandate = await service.createActionMandate(user, projectId, {
      granteeIdentityId: "claims-agent", audience: ["SandboxClaims"], permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["SandboxClaims:SUBMIT"], permittedResources: ["SandboxClaims"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const revoked = await service.revokeActionMandate(user, projectId, mandate.id, { reason: "Claims workflow was disabled." });
    expect(revoked).toMatchObject({ status: "REVOKED", statusReason: "Claims workflow was disabled.", statusChangedBy: user.userId });
    const action = await service.proposeAction(user, projectId, {
      externalId: "revoked-mandate-action", principal: { id: "claims-agent" }, actionType: "SUBMIT",
      targetSystem: "SandboxClaims", requestedPermissions: ["SandboxClaims:SUBMIT"], mandateId: mandate.id, requireMandate: true,
    });
    expect(action).toMatchObject({ decision: "DENY", status: "DENIED" });
    expect(action.reasons).toContain("mandate_revoked");
  });

  it("rejects delegation that expands resources, value, expiry, uses, or depth", () => {
    const parent = mandateFor(action()).payload;
    const child: ActionMandatePayload = {
      ...parent, mandateId: randomUUID(), parentMandateId: parent.mandateId,
      issuerIdentityId: parent.granteeIdentityId, granteeIdentityId: "sub-agent", permittedResources: ["ProductionClaims"],
      constraints: { ...parent.constraints, monetaryLimit: 10_000 }, expiresAt: "2026-09-22T00:00:00.000Z",
      maxUses: 2, maxDelegationDepth: parent.maxDelegationDepth,
    };
    expect(validateDelegationAttenuation(parent, child)).toEqual(expect.arrayContaining([
      "delegation_resource_scope_expanded", "delegation_monetary_limit_expanded", "delegation_expiry_extended",
      "delegation_uses_expanded", "delegation_depth_not_attenuated",
    ]));
  });

  it("does not upgrade unsigned outcome claims or SDK declarations to ENFORCED", () => {
    const value = action();
    const digest = actionIntentDigest(value);
    const policy: ActionPolicyDecisionRecord = {
      id: randomUUID(), projectId: value.projectId, actionId: value.id, actionDigestSha256: digest,
      policyId: "policy", policyVersion: "1", result: "ALLOW", reasonCodes: [], humanReadableExplanation: "Allowed.",
      obligations: [], requiredApprovers: [], evaluatedContextDigest: "a".repeat(64), evaluatedAt: value.updatedAt, evaluatorIdentity: "test",
    };
    const outcome: OutcomeAttestationRecord = {
      id: randomUUID(), projectId: value.projectId, actionId: value.id, actionDigestSha256: digest,
      predicateId: "expected", predicateVersion: "1", expectedState: value.expectedState!, observedState: value.expectedState!, result: "SATISFIED",
      observationMethod: "TARGET_API", observationSource: "caller-declared-api", collectedAt: value.updatedAt,
      evidenceReferences: [], confidence: 1,
    };
    const receipt = createActionAssuranceReceipt({
      action: value, mandate: mandateFor(value), policyDecision: policy, approvals: [], outcome, evidence: [], issuerId: "test",
      enforcementProof: { level: "ENFORCED", method: "SIGNED_ADAPTER", verified: true },
      validUntil: "2026-08-01T00:00:00.000Z", now: new Date("2026-07-23T00:00:00.000Z"),
    });
    expect(receipt.core.enforcementLevel).toBe("SELF_REPORTED");
    expect(receipt.core.evidenceStrength).toBe("REPORTED");
    expect(receipt.core.warnings).toEqual(expect.arrayContaining(["execution_boundary_not_verified", "outcome_provenance_unverified"]));
  });

  it("runs the hosted mandate-to-signed-receipt slice without overstating evidence", async () => {
    const { service, projectId, evidenceSigner } = await setup();
    const agent = await service.createAgent(user, projectId, { externalId: "claims-agent", name: "Claims Agent", version: "1.0.0", allowedPermissions: ["SandboxClaims:SUBMIT"] });
    const mandate = await service.createActionMandate(user, projectId, {
      granteeIdentityId: "claims-agent", audience: ["SandboxClaims"], permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["SandboxClaims:SUBMIT"], permittedResources: ["SandboxClaims"], constraints: { monetaryLimit: 5_000, approvalRequirement: "HUMAN" },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(), maxUses: 1, maxDelegationDepth: 0,
    });
    const proposed = await service.proposeAction(user, projectId, {
      externalId: "sandbox-claim", agentId: agent.id, principal: { id: "claims-agent", version: "1.0.0" }, actionType: "SUBMIT",
      targetSystem: "SandboxClaims", requestedPermissions: ["SandboxClaims:SUBMIT"], amount: 4_850, currency: "USD",
      expectedState: { status: "SUBMITTED" }, mandateId: mandate.id, requireMandate: true,
    });
    expect(proposed).toMatchObject({ status: "PENDING_APPROVAL", assuranceContext: { mandateId: mandate.id, mandateDigestSha256: mandate.digestSha256 } });
    const exhausted = await service.proposeAction(user, projectId, {
      externalId: "sandbox-claim-replay", agentId: agent.id, principal: { id: "claims-agent", version: "1.0.0" }, actionType: "SUBMIT",
      targetSystem: "SandboxClaims", requestedPermissions: ["SandboxClaims:SUBMIT"], amount: 4_850, currency: "USD",
      expectedState: { status: "SUBMITTED" }, mandateId: mandate.id, requireMandate: true,
    });
    expect(exhausted).toMatchObject({ status: "DENIED", decision: "DENY" });
    expect(exhausted.reasons).toContain("mandate_uses_exhausted");
    await service.reviewAction(user, projectId, proposed.id, true, { comment: "Approved for sandbox." });
    await service.verifyAction({ kind: "api_key", projectId, apiKeyId: "sandbox-key" }, projectId, proposed.id, { observedState: { status: "SUBMITTED" } });
    const stored = await service.issueActionAssuranceReceipt(user, projectId, proposed.id);
    expect(stored.receipt.core).toMatchObject({ evidenceStrength: "REPORTED", enforcementLevel: "SELF_REPORTED", outcomeAttestation: { result: "SATISFIED", observationMethod: "AGENT_SELF_REPORT" } });
    expect(stored.receipt.core.warnings).toContain("outcome_agent_self_reported");
    expect(verifyActionAssuranceReceipt(stored.receipt, { [evidenceSigner.keyId]: evidenceSigner.publicKeyPem }, new Date(stored.createdAt))).toMatchObject({ result: "VALID_WITH_WARNINGS" });
  });

  it("fails verification when receipt content is modified", () => {
    const value = action();
    const digest = actionIntentDigest(value);
    const policy: ActionPolicyDecisionRecord = {
      id: randomUUID(), projectId: value.projectId, actionId: value.id, actionDigestSha256: digest, policyId: "policy", policyVersion: "1",
      result: "ALLOW", reasonCodes: [], humanReadableExplanation: "Allowed.", obligations: [], requiredApprovers: [],
      evaluatedContextDigest: "a".repeat(64), evaluatedAt: value.updatedAt, evaluatorIdentity: "test",
    };
    const evidenceSigner = signer();
    const receipt = createActionAssuranceReceipt({ action: value, mandate: mandateFor(value), policyDecision: policy, approvals: [], evidence: [], issuerId: "test", signer: evidenceSigner, validUntil: "2026-08-01T00:00:00.000Z", now: new Date("2026-07-23T00:00:00.000Z") });
    receipt.core.actionId = "tampered";
    expect(verifyActionAssuranceReceipt(receipt, { [evidenceSigner.keyId]: evidenceSigner.publicKeyPem }, new Date("2026-07-23T01:00:00.000Z"))).toMatchObject({ result: "INVALID" });
  });
});
