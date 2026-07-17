import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileMandateStore,
  TrustedActionRecorder,
  createTrustedActionRuntime,
  generateSourceSigner,
  issueActionMandate,
  resetActionGatewayStore,
  sha256,
  type ControlledActionAdapter,
  createControlledActionAdapter,
  createIndependentOutcomeProbe,
} from "../src/index.js";

describe("trusted action runtime", () => {
  it("binds a signed mandate, enforces the gateway, independently verifies state, and emits outcome-verified evidence", async () => {
    resetActionGatewayStore();
    const directory = await mkdtemp(join(tmpdir(), "agentcert-trusted-runtime-"));
    const signer = generateSourceSigner("customer-key-1");
    const mandateStore = await FileMandateStore.open(join(directory, "mandates.jsonl"));
    const mandate = issueActionMandate({
      mandateId: "mandate-submit-1",
      issuer: { id: "owner@example.test", type: "human" },
      subject: { principalId: "browser-agent", agentVersion: "1.0.0" },
      scope: {
        actionTypes: ["SUBMIT"], targetSystems: ["SandboxERP"], permissions: ["SandboxERP:SUBMIT"],
        businessObjectIds: ["PO-4850"], currencies: ["USD"], maxAmount: 5_000,
      },
      expectedOutcome: { status: "SUBMITTED", purchaseOrderId: "PO-4850" },
      policySha256: sha256("submit-policy-v1"),
      validFrom: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-18T00:00:00.000Z",
      issuedAt: "2026-07-17T00:00:00.000Z",
    }, signer);
    await mandateStore.put(mandate);
    const recorder = await TrustedActionRecorder.open({
      runId: "trusted-submit-run",
      storageDirectory: join(directory, "recorder"),
      collector: { id: "browser-agent-recorder", version: "0.1.0", environment: "test" },
      signer,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    let systemState = { status: "DRAFT", purchaseOrderId: "PO-4850" };
    const adapter: ControlledActionAdapter = createControlledActionAdapter({
      name: "sandbox-erp-write-gateway",
      control: {
        mode: "agentcert_gateway", credentials: "gateway_managed", bypassPrevention: "credentials_unavailable_to_agent",
        allowedActionTypes: ["SUBMIT"], allowedTargetSystems: ["SandboxERP"],
      },
      execute: async (action) => {
        systemState = structuredClone(action.proposedAfterState) as typeof systemState;
        return { observedState: structuredClone(systemState), previousState: { status: "DRAFT", purchaseOrderId: "PO-4850" } };
      },
    });
    const runtime = createTrustedActionRuntime({
      recorder,
      mandateStore,
      mandatePublicKeys: { [signer.keyId]: signer.publicKeyPem },
      outcomeProbe: createIndependentOutcomeProbe({
        name: "sandbox-erp-read-api",
        independent: true,
        observe: async () => ({
          observationId: "observation-1", observedAt: "2026-07-17T12:00:01.000Z", source: "GET /api/purchase-orders/PO-4850",
          observedState: structuredClone(systemState),
        }),
      }),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });

    await runtime.startRun({ workflow: "purchase-order-submit" });
    const review = await runtime.captureAction({
      mandateId: mandate.mandateId,
      action: {
        sourceAgentName: "BrowserAgent", principal: { id: "browser-agent", type: "agent", version: "1.0.0" },
        requestedPermissions: ["SandboxERP:SUBMIT"], actionType: "SUBMIT", targetSystem: "SandboxERP",
        title: "Submit PO-4850", description: "Submit approved purchase order", businessObjectType: "purchase_order",
        businessObjectId: "PO-4850", amount: 4_850, currency: "USD", beforeState: systemState,
        proposedAfterState: { status: "SUBMITTED", purchaseOrderId: "PO-4850" },
      },
    });
    await runtime.approveAction(review.action, "reviewer@example.test", "Approved after checking vendor and amount.");
    const result = await runtime.executeAndVerify(review.action, adapter);
    expect(result.verification).toMatchObject({ success: true, verificationMethod: "INDEPENDENT_PROBE" });
    const packet = await runtime.finalize(review.action);
    expect(packet.trustedActionEvidence.evidenceStrength.level).toBe("outcome_verified");
    expect(packet.trustedActionEvidence.runReceipt).toMatchObject({ droppedEventCount: 0, journal: { valid: true, complete: true } });
    expect(packet.trustedActionEvidence.mandate.digestSha256).toBe(mandate.digestSha256);
    expect(JSON.stringify(packet)).not.toContain("gateway-secret");
  });

  it("rejects execution through an adapter without credential isolation", async () => {
    resetActionGatewayStore();
    const { runtime, mandate } = await setupRuntime();
    await runtime.startRun();
    const review = await runtime.captureAction({
      mandateId: mandate.mandateId,
      action: {
        sourceAgentName: "BrowserAgent", principal: { id: "browser-agent", type: "agent", version: "1.0.0" },
        actionType: "SUBMIT", targetSystem: "SandboxERP", title: "Submit", description: "Submit",
        businessObjectType: "purchase_order", businessObjectId: "PO-1", requestedPermissions: ["SandboxERP:SUBMIT"],
        amount: 4_850, currency: "USD",
        proposedAfterState: { status: "SUBMITTED" },
      },
    });
    await runtime.requestApproval(review.action, "reviewer@example.test");
    await runtime.approveAction(review.action, "reviewer@example.test");
    await expect(runtime.executeAndVerify(review.action, {
      name: "unsafe-adapter",
      execute: async () => ({ observedState: { status: "SUBMITTED" } }),
    } as ControlledActionAdapter)).rejects.toThrow("not a registered AgentCert controlled adapter");
  });
});

async function setupRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "agentcert-trusted-setup-"));
  const signer = generateSourceSigner("customer-key-1");
  const mandateStore = await FileMandateStore.open(join(directory, "mandates.jsonl"));
  const mandate = issueActionMandate({
    mandateId: "mandate-1", issuer: { id: "owner", type: "human" }, subject: { principalId: "browser-agent", agentVersion: "1.0.0" },
    scope: { actionTypes: ["SUBMIT"], targetSystems: ["SandboxERP"], permissions: ["SandboxERP:SUBMIT"], businessObjectIds: ["PO-1"] },
    expectedOutcome: { status: "SUBMITTED" }, policySha256: sha256("policy"),
    validFrom: "2026-07-17T00:00:00.000Z", expiresAt: "2026-07-18T00:00:00.000Z", issuedAt: "2026-07-17T00:00:00.000Z",
  }, signer);
  await mandateStore.put(mandate);
  const recorder = await TrustedActionRecorder.open({
    runId: "run-1", storageDirectory: join(directory, "recorder"),
    collector: { id: "collector", version: "0.1.0", environment: "test" }, signer,
  });
  return {
    mandate,
    runtime: createTrustedActionRuntime({
      recorder, mandateStore, mandatePublicKeys: { [signer.keyId]: signer.publicKeyPem },
      outcomeProbe: createIndependentOutcomeProbe({ name: "read-probe", independent: true, observe: async () => ({ observationId: "obs", observedAt: new Date().toISOString(), source: "read", observedState: { status: "SUBMITTED" } }) }),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    }),
  };
}
