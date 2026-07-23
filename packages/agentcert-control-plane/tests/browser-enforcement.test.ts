import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  containsSecretMaterial,
  createSignedExecutionGrant,
  runtimeIdentityTrustedAt,
  verifySignedExecutionGrant,
  type BrowserEnforcementSessionRecord,
  type ExecutionGrantRecord,
  type RuntimeIdentityRecord,
} from "../src/browser-enforcement.js";
import { EvidenceSigner } from "../src/signing.js";
import { InMemoryControlPlaneStore } from "../src/store.js";

function signer() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new EvidenceSigner("browser-enforcement-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

function signedGrant(evidenceSigner = signer(), now = new Date()) {
  return createSignedExecutionGrant({
    signer: evidenceSigner,
    executionGrantId: randomUUID(),
    tenantId: randomUUID(),
    actionId: randomUUID(),
    actionIntentDigest: "a".repeat(64),
    principalIdentityId: "principal",
    agentIdentityId: "agent",
    agentBuildId: "agent@1.0.0",
    agentBuildDigest: "b".repeat(64),
    mandateId: randomUUID(),
    mandateChainDigest: "c".repeat(64),
    policyDecisionId: randomUUID(),
    policyDecisionDigest: "d".repeat(64),
    approvalSetDigest: "e".repeat(64),
    adapterId: "agentcert.browser.submit",
    adapterVersionConstraint: "^0.2.0",
    expectedRuntimeIdentityId: randomUUID(),
    targetAudience: "Sandbox",
    allowedOrigins: ["https://sandbox.example"],
    allowedOperation: "SUBMIT",
    allowedResource: "purchase_order/PO-1",
    parametersDigest: "f".repeat(64),
    outcomePredicateDigest: "1".repeat(64),
    credentialIsolationRequirement: "REQUIRED",
    reconciliationRequirement: "REQUIRED",
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
}

describe("Browser enforcement boundary v0.2", () => {
  it("verifies the exact signed grant and rejects expiry or mutation", () => {
    const evidenceSigner = signer();
    const issuedAt = new Date("2026-07-22T12:00:00.000Z");
    const grant = signedGrant(evidenceSigner, issuedAt);
    const keys = { [evidenceSigner.keyId]: evidenceSigner.publicKeyPem };
    expect(verifySignedExecutionGrant(grant, keys, new Date("2026-07-22T12:00:30.000Z"))).toEqual([]);
    expect(verifySignedExecutionGrant(grant, keys, new Date("2026-07-22T12:02:00.000Z"), 0)).toContain("EXECUTION_GRANT_EXPIRED");
    const tampered = structuredClone(grant);
    tampered.payload.allowedOperation = "PAY";
    expect(verifySignedExecutionGrant(tampered, keys, issuedAt)).toEqual(expect.arrayContaining(["EXECUTION_GRANT_DIGEST_MISMATCH", "EXECUTION_GRANT_INVALID_SIGNATURE"]));
  });

  it("detects credential-shaped fields and values while allowing opaque references", () => {
    expect(containsSecretMaterial({ providerReference: `opaque:${"a".repeat(64)}` })).toBe(false);
    expect(containsSecretMaterial({ authorization: "[REDACTED]" })).toBe(true);
    expect(containsSecretMaterial({ note: "Bearer this-is-a-secret-token" })).toBe(true);
  });

  it("atomically allows one claim and rejects a concurrent distinct replay", async () => {
    const store = new InMemoryControlPlaneStore();
    const grant = signedGrant();
    const now = new Date().toISOString();
    const record: ExecutionGrantRecord = {
      id: grant.payload.executionGrantId,
      projectId: grant.payload.tenantId,
      actionId: grant.payload.actionId,
      grant,
      status: "ISSUED",
      createdAt: now,
      updatedAt: now,
    };
    await store.insertExecutionGrant(record);
    const session = (id: string): BrowserEnforcementSessionRecord => ({
      id,
      projectId: record.projectId,
      actionId: record.actionId,
      executionGrantId: record.id,
      runtimeIdentityId: grant.payload.expectedRuntimeIdentityId,
      runtimeClaim: { payload: {} as never, payloadSha256: "0".repeat(64), signature: { algorithm: "Ed25519", keyId: "runtime", signature: "fixture" } },
      status: "CLAIMED",
      createdAt: now,
      updatedAt: now,
    });
    const [first, second] = await Promise.all([
      store.claimExecutionGrant(record.projectId, record.id, grant.payload.expectedRuntimeIdentityId, session(randomUUID()), "claim-a", now),
      store.claimExecutionGrant(record.projectId, record.id, grant.payload.expectedRuntimeIdentityId, session(randomUUID()), "claim-b", now),
    ]);
    expect([first.result, second.result].sort()).toEqual(["CLAIMED", "REPLAY_REJECTED"]);
  });

  it("preserves evidence before revocation and rejects evidence at or after the effective time", () => {
    const runtime: RuntimeIdentityRecord = {
      runtimeIdentityId: randomUUID(), projectId: randomUUID(), runtimeInstanceId: "runtime-1", runtimeType: "ONEGENT_BROWSER_GATEWAY",
      adapterCapabilities: ["agentcert.browser.submit"], publicKeyPem: "fixture", keyId: "key-1", keyAlgorithm: "Ed25519",
      status: "REVOKED", validFrom: "2026-07-22T10:00:00.000Z", validUntil: "2026-07-23T10:00:00.000Z",
      registeredAt: "2026-07-22T10:00:00.000Z", registrationMethod: "DEVELOPMENT_FIXTURE", metadata: {},
      statusChangedAt: "2026-07-22T12:00:00.000Z", statusReason: "Routine key rotation.",
    };
    expect(runtimeIdentityTrustedAt(runtime, new Date("2026-07-22T11:59:59.000Z"))).toBe(true);
    expect(runtimeIdentityTrustedAt(runtime, new Date("2026-07-22T12:00:00.000Z"))).toBe(false);
    expect(runtimeIdentityTrustedAt({ ...runtime, status: "COMPROMISED", statusChangedAt: "2026-07-22T11:00:00.000Z" }, new Date("2026-07-22T11:30:00.000Z"))).toBe(false);
  });
});
