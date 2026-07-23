import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { AgentCertControlPlane } from "../src/service.js";
import { EvidenceSigner } from "../src/signing.js";
import { PostgresControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const databaseUrl = process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL;

describe.skipIf(!databaseUrl)("Action Assurance Postgres acceptance", () => {
  it("migrates, atomically consumes a mandate, and recovers a signed receipt", async () => {
    const owner: AuthContext = { kind: "user", userId: randomUUID(), email: "action-assurance-postgres@example.com" };
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new EvidenceSigner("postgres-action-assurance-key", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const store = new PostgresControlPlaneStore(databaseUrl!);
    await store.migrate();
    const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], signer);
    const { project } = await service.bootstrap(owner);
    const agent = await service.createAgent(owner, project.id, {
      externalId: "claims-agent", name: "Claims Agent", version: "1.0.0", allowedPermissions: ["SandboxClaims:SUBMIT"],
    });
    const mandate = await service.createActionMandate(owner, project.id, {
      granteeIdentityId: "claims-agent", audience: ["SandboxClaims"], permittedActionClasses: ["SUBMIT"],
      permittedOperations: ["SandboxClaims:SUBMIT"], permittedResources: ["SandboxClaims"],
      constraints: { monetaryLimit: 5_000, approvalRequirement: "HUMAN" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxUses: 1,
    });
    const input = {
      agentId: agent.id, principal: { id: "claims-agent" }, actionType: "SUBMIT" as const, targetSystem: "SandboxClaims",
      requestedPermissions: ["SandboxClaims:SUBMIT"], amount: 4_850, expectedState: { status: "SUBMITTED" },
      mandateId: mandate.id, requireMandate: true,
    };
    const accepted = await service.proposeAction(owner, project.id, { ...input, externalId: "postgres-action-1" });
    const exhausted = await service.proposeAction(owner, project.id, { ...input, externalId: "postgres-action-2" });
    expect(accepted.status).toBe("PENDING_APPROVAL");
    expect(exhausted).toMatchObject({ decision: "DENY", status: "DENIED" });
    expect(exhausted.reasons).toContain("mandate_uses_exhausted");

    await service.reviewAction(owner, project.id, accepted.id, true, { comment: "Approved in acceptance test." });
    await service.verifyAction({ kind: "api_key", projectId: project.id, apiKeyId: "postgres-test" }, project.id, accepted.id, {
      observedState: { status: "SUBMITTED" },
    });
    const receipt = await service.issueActionAssuranceReceipt(owner, project.id, accepted.id);

    const recovered = new AgentCertControlPlane(new PostgresControlPlaneStore(databaseUrl!), new MemoryArtifactStore(), undefined, [], signer);
    await expect(recovered.getActionAssuranceReceipt(owner, project.id, receipt.id)).resolves.toMatchObject({
      id: receipt.id,
      actionId: accepted.id,
      receipt: { core: { evidenceStrength: "REPORTED" } },
    });
  });
});
