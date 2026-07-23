import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentCertControlPlane,
  EvidenceSigner,
  InMemoryControlPlaneStore,
  MemoryArtifactStore,
  actionIntentDigest,
  classifyBrowserEnforcement,
  verifyActionAssuranceReceipt,
} from "../packages/agentcert-control-plane/dist/index.js";
import {
  TrustedActionRecorder,
  canonicalJson,
  createControlledActionAdapter,
  createIndependentOutcomeProbe,
  executeBrowserEnforcement,
  generateSourceSigner,
  sha256,
} from "../packages/onegent-runtime/dist/index.js";

const TARGET_SYSTEM = "AgentCertProcurementSandbox";
const ADAPTER_ID = "agentcert.browser.procurement-submit";
const ADAPTER_VERSION = "0.2.0";

test("Browser enforcement v0.2 produces centrally-derived ENFORCED evidence without leaking credentials", async (t) => {
  const sandbox = await startProcurementSandbox();
  t.after(() => sandbox.close());
  const fixture = await createFixture(sandbox);
  const result = await executeScenario(fixture, { purchaseOrderId: "PO-4850" });

  assert.equal(result.session.evaluation.enforcementLevel, "ENFORCED");
  assert.equal(result.session.evaluation.assuranceProfile, "BROWSER_ENFORCED_V0_2");
  assert.ok(result.session.evaluation.checks.every((check) => check.result === "PASS"));
  assert.equal(result.bundle.reconciliationReport.payload.result, "PASSED");
  assert.equal(result.bundle.outcomeAttestation.payload.result, "SATISFIED");
  assert.equal(result.bundle.credentialLease.status, "REVOKED");
  assert.equal(result.recorder.validation().valid, true);
  assert.equal(result.recorder.validation().droppedEventCount, 0);

  const receipt = await fixture.service.issueActionAssuranceReceipt(fixture.owner, fixture.projectId, result.hostedAction.id);
  assert.equal(receipt.receipt.core.enforcementLevel, "ENFORCED");
  assert.equal(receipt.receipt.core.evidenceStrength, "ENFORCED");
  assert.equal(receipt.receipt.core.assuranceProfile, "BROWSER_ENFORCED_V0_2");
  await assert.rejects(
    fixture.service.issueBrowserExecutionGrant(fixture.owner, fixture.projectId, result.hostedAction.id, {
      runtimeIdentityId: fixture.runtimeIdentity.runtimeIdentityId,
      adapterId: ADAPTER_ID,
      allowedOrigins: [fixture.sandbox.origin],
      approvedParameters: result.approvedParameters,
      outcomePredicate: result.outcomePredicate,
      agentBuildId: "procurement-browser-agent@1.0.0",
      agentBuildDigest: result.agentBuildDigest,
    }),
    (error) => error?.code === "execution_grant_exists",
  );
  const verified = verifyActionAssuranceReceipt(
    receipt.receipt,
    { [fixture.hostedSigner.keyId]: fixture.hostedSigner.publicKeyPem },
    new Date(receipt.createdAt),
    { evidence: result.bundle, runtimeIdentity: fixture.runtimeIdentity },
  );
  assert.equal(verified.result, "VALID");

  const serialized = canonicalJson({ bundle: result.bundle, receipt: receipt.receipt });
  assert.equal(serialized.includes(sandbox.writeCredential), false);
  assert.equal(serialized.includes(sandbox.readCredential), false);
  assert.equal(serialized.includes("Authorization"), false);
});

test("one-time redemption, parameter binding, revocation, and reconciliation fail closed", async (t) => {
  const sandbox = await startProcurementSandbox();
  t.after(() => sandbox.close());
  const fixture = await createFixture(sandbox);
  const successful = await executeScenario(fixture, { purchaseOrderId: "PO-1001" });

  const replay = structuredClone(successful.bundle.runtimeClaim);
  replay.payload.executionSessionId = randomUUID();
  await assert.rejects(
    fixture.service.claimBrowserExecutionGrant(fixture.projectId, successful.grant.id, replay),
    (error) => error?.code === "runtime_proof_invalid" || error?.code === "execution_grant_replay",
  );

  const parameterFixture = await provisionAction(fixture, "PO-1002");
  const recorder = await openRecorder(parameterFixture.hostedAction.id, fixture.runtimeSigner);
  await recorder.start({ actionId: parameterFixture.hostedAction.id });
  let revokeCount = 0;
  const mismatchedOptions = createRuntimeOptions(fixture, parameterFixture, recorder, { purchaseOrderId: "PO-MUTATED", status: "SUBMITTED" });
  mismatchedOptions.credentialLease.revoke = () => { revokeCount += 1; };
  await assert.rejects(
    executeBrowserEnforcement(mismatchedOptions),
    /PARAMETERS_DIGEST_MISMATCH/,
  );
  assert.equal(revokeCount, 1);
  assert.equal(sandbox.getOrder("PO-1002").status, "DRAFT");

  const revokedFixture = await provisionAction(fixture, "PO-1003");
  await fixture.service.revokeBrowserExecutionGrant(fixture.owner, fixture.projectId, revokedFixture.grant.id, { reason: "Operator cancelled the execution." });
  const revokedRecorder = await openRecorder(revokedFixture.hostedAction.id, fixture.runtimeSigner);
  await revokedRecorder.start({ actionId: revokedFixture.hostedAction.id });
  await assert.rejects(
    executeBrowserEnforcement(createRuntimeOptions(fixture, revokedFixture, revokedRecorder, revokedFixture.approvedParameters)),
    /EXECUTION_GRANT|grant/i,
  );
  assert.equal(sandbox.getOrder("PO-1003").status, "DRAFT");

  const tampered = structuredClone(successful.bundle);
  tampered.executionSession.payload.adapterVersion = "9.0.0";
  const evaluation = classifyBrowserEnforcement({
    bundle: tampered,
    runtimeIdentity: fixture.runtimeIdentity,
    issuerKeys: { [fixture.hostedSigner.keyId]: fixture.hostedSigner.publicKeyPem },
  });
  assert.notEqual(evaluation.enforcementLevel, "ENFORCED");
  assert.ok(evaluation.reasonCodes.includes("EXECUTION_SESSION_BINDING_MISMATCH") || evaluation.reasonCodes.includes("RUNTIME_PROOF_INVALID"));

  const bypassFixture = await provisionAction(fixture, "PO-1004");
  const bypassRecorder = await openRecorder(bypassFixture.hostedAction.id, fixture.runtimeSigner);
  await bypassRecorder.start({ actionId: bypassFixture.hostedAction.id });
  const bypass = await executeBrowserEnforcement(createRuntimeOptions(fixture, bypassFixture, bypassRecorder, bypassFixture.approvedParameters, true));
  const bypassSession = await fixture.service.submitBrowserEnforcementEvidence(fixture.projectId, bypass.executionSession.payload.executionSessionId, bypass);
  assert.equal(bypass.reconciliationReport.payload.result, "BYPASS_DETECTED");
  assert.notEqual(bypassSession.evaluation.enforcementLevel, "ENFORCED");
  assert.ok(bypassSession.evaluation.reasonCodes.includes("BYPASS_DETECTED"));

  const suspendedFixture = await provisionAction(fixture, "PO-1005");
  const suspendedIdentity = await fixture.service.updateBrowserRuntimeIdentityStatus(
    fixture.owner,
    fixture.projectId,
    fixture.runtimeIdentity.runtimeIdentityId,
    { status: "SUSPENDED", reason: "Negative-path runtime lifecycle test." },
  );
  const historicalEvaluation = classifyBrowserEnforcement({
    bundle: successful.bundle,
    runtimeIdentity: suspendedIdentity,
    issuerKeys: { [fixture.hostedSigner.keyId]: fixture.hostedSigner.publicKeyPem },
  });
  assert.equal(historicalEvaluation.enforcementLevel, "ENFORCED");
  const suspendedRecorder = await openRecorder(suspendedFixture.hostedAction.id, fixture.runtimeSigner);
  await suspendedRecorder.start({ actionId: suspendedFixture.hostedAction.id });
  await assert.rejects(
    executeBrowserEnforcement(createRuntimeOptions(fixture, suspendedFixture, suspendedRecorder, suspendedFixture.approvedParameters)),
    (error) => error?.code === "runtime_identity_untrusted",
  );
  assert.equal(sandbox.getOrder("PO-1005").status, "DRAFT");
});

async function createFixture(sandbox) {
  const owner = { kind: "user", userId: randomUUID(), email: "browser-enforcement@example.test" };
  const { privateKey } = generateKeyPairSync("ed25519");
  const hostedSigner = new EvidenceSigner("hosted-browser-enforcement-v02", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const service = new AgentCertControlPlane(new InMemoryControlPlaneStore(), new MemoryArtifactStore(), undefined, [], hostedSigner);
  const { project } = await service.bootstrap(owner);
  const agent = await service.createAgent(owner, project.id, {
    externalId: "procurement-browser-agent",
    name: "Procurement Browser Agent",
    version: "1.0.0",
    allowedPermissions: [`${TARGET_SYSTEM}:SUBMIT`],
  });
  const runtimeSigner = generateSourceSigner("onegent-browser-runtime-v02");
  const runtimeIdentity = await service.registerBrowserRuntimeIdentity(owner, project.id, {
    runtimeInstanceId: "onegent-browser-gateway-e2e",
    publicKeyPem: runtimeSigner.publicKeyPem,
    keyId: runtimeSigner.keyId,
    adapterCapabilities: [ADAPTER_ID],
    validUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    developmentFixture: true,
    metadata: { profile: "BROWSER_ENFORCED_V0_2" },
  });
  return { owner, hostedSigner, service, projectId: project.id, agent, runtimeSigner, runtimeIdentity, sandbox };
}

async function provisionAction(fixture, purchaseOrderId) {
  fixture.sandbox.ensureOrder(purchaseOrderId);
  const mandate = await fixture.service.createActionMandate(fixture.owner, fixture.projectId, {
    granteeIdentityId: "procurement-browser-agent",
    audience: [TARGET_SYSTEM],
    permittedActionClasses: ["SUBMIT"],
    permittedOperations: [`${TARGET_SYSTEM}:SUBMIT`],
    permittedResources: [TARGET_SYSTEM],
    constraints: { monetaryLimit: 5_000, approvalRequirement: "HUMAN" },
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    maxUses: 1,
  });
  const hostedAction = await fixture.service.proposeAction(fixture.owner, fixture.projectId, {
    externalId: `submit-${purchaseOrderId}-${randomUUID()}`,
    agentId: fixture.agent.id,
    principal: { id: "procurement-browser-agent", version: "1.0.0" },
    actionType: "SUBMIT",
    targetSystem: TARGET_SYSTEM,
    requestedPermissions: [`${TARGET_SYSTEM}:SUBMIT`],
    amount: 4_850,
    currency: "USD",
    expectedState: { purchaseOrderId, status: "SUBMITTED" },
    mandateId: mandate.id,
    requireMandate: true,
  });
  await fixture.service.reviewAction(fixture.owner, fixture.projectId, hostedAction.id, true, { comment: "Approved for the isolated procurement sandbox." });
  const approvedParameters = { purchaseOrderId, status: "SUBMITTED" };
  const outcomePredicate = { type: "state_subset", expected: approvedParameters };
  const agentBuildDigest = sha256("procurement-browser-agent@1.0.0");
  const grant = await fixture.service.issueBrowserExecutionGrant(fixture.owner, fixture.projectId, hostedAction.id, {
    runtimeIdentityId: fixture.runtimeIdentity.runtimeIdentityId,
    adapterId: ADAPTER_ID,
    adapterVersionConstraint: "^0.2.0",
    allowedOrigins: [fixture.sandbox.origin],
    approvedParameters,
    outcomePredicate,
    agentBuildId: "procurement-browser-agent@1.0.0",
    agentBuildDigest,
    allowedOperation: "SUBMIT",
    allowedResource: `purchase_order/${purchaseOrderId}`,
    ttlSeconds: 120,
  });
  const action = {
    id: hostedAction.id,
    idempotencyKey: hostedAction.externalId,
    workspaceId: fixture.projectId,
    workflowId: "procurement-submit",
    sourceAgentName: "ProcurementAgent",
    principal: { id: "procurement-browser-agent", type: "agent", version: "1.0.0" },
    requestedPermissions: [`${TARGET_SYSTEM}:SUBMIT`],
    mandateId: mandate.id,
    actionType: "SUBMIT",
    targetSystem: TARGET_SYSTEM,
    targetUrl: `${fixture.sandbox.origin}/purchase-orders/${purchaseOrderId}`,
    environment: "staging",
    title: "Submit purchase order",
    description: "Submit the approved purchase order in the isolated sandbox.",
    businessObjectType: "purchase_order",
    businessObjectId: purchaseOrderId,
    amount: 4_850,
    currency: "USD",
    beforeState: { purchaseOrderId, status: "DRAFT" },
    proposedAfterState: approvedParameters,
    fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }],
    createdAt: hostedAction.createdAt,
    status: "APPROVED",
  };
  return { mandate, hostedAction, approvedParameters, outcomePredicate, agentBuildDigest, grant, action };
}

async function executeScenario(fixture, { purchaseOrderId }) {
  const provisioned = await provisionAction(fixture, purchaseOrderId);
  const recorder = await openRecorder(provisioned.hostedAction.id, fixture.runtimeSigner);
  await recorder.start({ actionId: provisioned.hostedAction.id, runtimeIdentityId: fixture.runtimeIdentity.runtimeIdentityId });
  const bundle = await executeBrowserEnforcement(createRuntimeOptions(fixture, provisioned, recorder, provisioned.approvedParameters));
  await recorder.complete({ executionSessionId: bundle.executionSession.payload.executionSessionId });
  const session = await fixture.service.submitBrowserEnforcementEvidence(fixture.projectId, bundle.executionSession.payload.executionSessionId, bundle);
  return { ...provisioned, bundle, session, recorder };
}

function createRuntimeOptions(fixture, provisioned, recorder, submittedParameters, addBypass = false) {
  let runtimeClaim;
  const adapter = createControlledActionAdapter({
    name: ADAPTER_ID,
    control: {
      mode: "agentcert_gateway",
      credentials: "gateway_managed",
      bypassPrevention: "credentials_unavailable_to_agent",
      allowedActionTypes: ["SUBMIT"],
      allowedTargetSystems: [TARGET_SYSTEM],
    },
    execute: async (action, context) => {
      const submit = async (body) => {
        const response = await fetch(`${fixture.sandbox.origin}/purchase-orders/${action.businessObjectId}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sandbox-write-credential": fixture.sandbox.writeCredential },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Sandbox submit failed with ${response.status}.`);
        return response.json();
      };
      const observed = await submit({ ...submittedParameters, actionId: action.id, executionSessionId: context.idempotencyKey });
      if (addBypass) await submit({ ...submittedParameters, actionId: `bypass-${action.id}`, executionSessionId: `bypass-${context.idempotencyKey}` });
      return { method: "LOCAL_ADAPTER", targetSystem: TARGET_SYSTEM, previousState: action.beforeState, observedState: observed };
    },
  });
  const outcomeProbe = createIndependentOutcomeProbe({
    name: "procurement-sandbox-read-only-probe",
    independent: true,
    observe: async (action) => {
      const response = await fetch(`${fixture.sandbox.origin}/purchase-orders/${action.businessObjectId}`, { headers: { "x-sandbox-read-credential": fixture.sandbox.readCredential } });
      if (!response.ok) throw new Error(`Sandbox probe failed with ${response.status}.`);
      return { observationId: randomUUID(), observedAt: new Date().toISOString(), observedState: await response.json(), source: "isolated-sandbox-read-api" };
    },
  });
  return {
    grant: provisioned.grant.grant,
    hostedIssuerKeys: { [fixture.hostedSigner.keyId]: fixture.hostedSigner.publicKeyPem },
    runtime: { runtimeIdentityId: fixture.runtimeIdentity.runtimeIdentityId, runtimeKeyId: fixture.runtimeSigner.keyId, signer: fixture.runtimeSigner },
    action: provisioned.action,
    actionIntentDigest: actionIntentDigest(provisioned.hostedAction),
    agentBuildDigest: provisioned.agentBuildDigest,
    approvedParameters: submittedParameters,
    outcomePredicate: provisioned.outcomePredicate,
    adapter,
    adapterVersion: ADAPTER_VERSION,
    outcomeProbe,
    targetAuditSource: {
      name: "procurement-sandbox-audit-log",
      exclusiveCredential: true,
      listEvents: async (windowStart, windowEnd) => fixture.sandbox.listAuditEvents(windowStart, windowEnd),
    },
    recorder,
    credentialLease: {
      providerType: "DEVELOPMENT_SECRET_PROVIDER",
      providerReference: `sandbox-write:${fixture.projectId}`,
      isolationMode: "TARGET_EPHEMERAL_TOKEN",
      expiresAt: provisioned.grant.grant.payload.expiresAt,
    },
    claimGrant: async (claim) => {
      runtimeClaim = claim;
      await fixture.service.claimBrowserExecutionGrant(fixture.projectId, provisioned.grant.id, claim);
      return { status: "CLAIMED", claimedAt: claim.payload.claimedAt };
    },
    markConsumed: async (executionGrantId, executionSessionId) => {
      await fixture.service.consumeBrowserExecutionGrant(fixture.projectId, executionGrantId, { executionSessionId, runtimeClaim });
    },
  };
}

async function openRecorder(actionId, signer) {
  const directory = await mkdtemp(join(tmpdir(), "agentcert-browser-v02-"));
  return TrustedActionRecorder.open({
    runId: `browser-enforcement-${actionId}`,
    storageDirectory: directory,
    collector: { id: "onegent-browser-runtime", version: ADAPTER_VERSION, environment: "test" },
    signer,
  });
}

async function startProcurementSandbox() {
  const writeCredential = `write-${randomUUID()}`;
  const readCredential = `read-${randomUUID()}`;
  const orders = new Map();
  const auditEvents = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/purchase-orders\/([^/]+)(\/submit)?$/.exec(url.pathname);
      if (!match) return send(response, 404, { error: "not_found" });
      const purchaseOrderId = decodeURIComponent(match[1]);
      if (request.method === "GET" && !match[2]) {
        if (request.headers["x-sandbox-read-credential"] !== readCredential) return send(response, 401, { error: "unauthorized" });
        return send(response, 200, orders.get(purchaseOrderId) ?? { purchaseOrderId, status: "DRAFT" });
      }
      if (request.method === "POST" && match[2]) {
        if (request.headers["x-sandbox-write-credential"] !== writeCredential) return send(response, 401, { error: "unauthorized" });
        const body = await readJson(request);
        const previous = orders.get(purchaseOrderId) ?? { purchaseOrderId, status: "DRAFT" };
        const observed = { ...previous, purchaseOrderId, status: body.status };
        orders.set(purchaseOrderId, observed);
        auditEvents.push({
          targetEventId: randomUUID(),
          actionId: body.actionId,
          executionSessionId: body.executionSessionId,
          occurredAt: new Date().toISOString(),
          operation: "SUBMIT",
          resource: `purchase_order/${purchaseOrderId}`,
          parametersDigest: sha256(canonicalJson({ purchaseOrderId, status: body.status })),
          credentialReferenceDigest: sha256(`sandbox-write:${body.actionId ? "bound" : "unknown"}`),
        });
        return send(response, 200, observed);
      }
      return send(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      return send(response, 500, { error: error instanceof Error ? error.message : "internal_error" });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    writeCredential,
    readCredential,
    ensureOrder: (id) => { if (!orders.has(id)) orders.set(id, { purchaseOrderId: id, status: "DRAFT" }); },
    getOrder: (id) => structuredClone(orders.get(id)),
    listAuditEvents: async (from, to) => structuredClone(auditEvents.filter((event) => Date.parse(event.occurredAt) >= Date.parse(from) && Date.parse(event.occurredAt) <= Date.parse(to))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
