import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { BROWSER_ENFORCEMENT_PROTOCOL, RUNTIME_CLAIM_CONTEXT, digestCanonical, type RuntimeClaimPayload, type RuntimeSignedObject } from "../src/browser-enforcement.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner } from "../src/signing.js";
import { PostgresControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const databaseUrl = process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL;

describe.skipIf(!databaseUrl)("Browser enforcement Postgres acceptance", () => {
  it("migrates v0.2 and admits exactly one of two concurrent grant claims", async () => {
    const owner: AuthContext = { kind: "user", userId: randomUUID(), email: "browser-enforcement-postgres@example.test" };
    const hostedKeys = generateKeyPairSync("ed25519");
    const runtimeKeys = generateKeyPairSync("ed25519");
    const hostedSigner = new EvidenceSigner("postgres-browser-enforcement", hostedKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const runtimeKeyId = "postgres-runtime-v02";
    const store = new PostgresControlPlaneStore(databaseUrl!);
    await store.migrate();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], hostedSigner);
    const { project } = await service.bootstrap(owner);
    const agent = await service.createAgent(owner, project.id, { externalId: "postgres-browser-agent", name: "Postgres Browser Agent", version: "1.0.0", allowedPermissions: ["Sandbox:SUBMIT"] });
    const runtime = await service.registerBrowserRuntimeIdentity(owner, project.id, {
      runtimeInstanceId: "postgres-browser-gateway",
      publicKeyPem: runtimeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyId: runtimeKeyId,
      adapterCapabilities: ["agentcert.browser.submit"],
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      developmentFixture: true,
    });
    const mandate = await service.createActionMandate(owner, project.id, {
      granteeIdentityId: "postgres-browser-agent", audience: ["Sandbox"], permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["Sandbox:SUBMIT"], permittedResources: ["Sandbox"], constraints: { approvalRequirement: "HUMAN" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxUses: 1,
    });
    const action = await service.proposeAction(owner, project.id, {
      externalId: `postgres-browser-${randomUUID()}`, agentId: agent.id, principal: { id: "postgres-browser-agent", version: "1.0.0" },
      actionType: "SUBMIT", targetSystem: "Sandbox", requestedPermissions: ["Sandbox:SUBMIT"], expectedState: { status: "SUBMITTED" },
      amount: 4_850, currency: "USD",
      mandateId: mandate.id, requireMandate: true,
    });
    await service.reviewAction(owner, project.id, action.id, true, { comment: "Concurrent claim acceptance." });
    const grant = await service.issueBrowserExecutionGrant(owner, project.id, action.id, {
      runtimeIdentityId: runtime.runtimeIdentityId,
      adapterId: "agentcert.browser.submit",
      adapterVersionConstraint: "^0.2.0",
      allowedOrigins: ["https://sandbox.example"],
      approvedParameters: { status: "SUBMITTED" },
      outcomePredicate: { type: "state_subset", status: "SUBMITTED" },
      agentBuildId: "postgres-browser-agent@1.0.0",
      agentBuildDigest: "a".repeat(64),
      allowedOperation: "SUBMIT",
      allowedResource: "order/1",
      ttlSeconds: 60,
    });
    const makeClaim = (sessionId: string, idempotencyKey: string) => signRuntimeClaim({
      protocolVersion: BROWSER_ENFORCEMENT_PROTOCOL,
      objectType: "RuntimeClaim",
      signatureContext: RUNTIME_CLAIM_CONTEXT,
      runtimeIdentityId: runtime.runtimeIdentityId,
      executionGrantId: grant.id,
      executionGrantDigest: grant.grant.payloadSha256,
      actionId: action.id,
      executionSessionId: sessionId,
      claimNonce: randomUUID(),
      claimedAt: new Date().toISOString(),
      runtimeKeyId,
      idempotencyKey,
    }, runtimeKeys.privateKey, runtimeKeyId);
    const results = await Promise.allSettled([
      service.claimBrowserExecutionGrant(project.id, grant.id, makeClaim(randomUUID(), "claim-a")),
      service.claimBrowserExecutionGrant(project.id, grant.id, makeClaim(randomUUID(), "claim-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "execution_grant_replay" } });
  });
});

function signRuntimeClaim(payload: RuntimeClaimPayload, privateKey: KeyObject, keyId: string): RuntimeSignedObject<RuntimeClaimPayload> {
  const payloadSha256 = digestCanonical(payload);
  return {
    payload,
    payloadSha256,
    signature: { algorithm: "Ed25519", keyId, signature: sign(null, Buffer.from(payloadSha256, "hex"), privateKey).toString("base64url") },
  };
}
