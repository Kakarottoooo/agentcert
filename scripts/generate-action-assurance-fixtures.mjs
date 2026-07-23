import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  actionIntentDigest,
  createActionAssuranceReceipt,
} from "../packages/agentcert-control-plane/dist/action-assurance.js";
import {
  canonicalJson,
  EvidenceSigner,
} from "../packages/agentcert-control-plane/dist/signing.js";

const outputRoot = resolve("schemas/action-assurance-receipt/v0.1");
const { privateKey } = generateKeyPairSync("ed25519");
const signer = new EvidenceSigner(
  "agentcert-action-receipt-example",
  privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
);
const action = {
  id: randomUUID(),
  projectId: randomUUID(),
  externalId: "submit-sandbox-claim",
  principal: { id: "claims-agent", version: "1.0.0" },
  actionType: "SUBMIT",
  targetSystem: "SandboxClaims",
  requestedPermissions: ["SandboxClaims:SUBMIT"],
  amount: 4850,
  currency: "USD",
  riskLevel: "HIGH",
  riskScore: 85,
  decision: "ALLOW",
  status: "APPROVED",
  policyVersion: "agentcert.default.v1",
  reasons: ["Human approval required for submissions above 1000 USD."],
  expectedState: { status: "SUBMITTED" },
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:01:00.000Z",
};
const digest = actionIntentDigest(action);
const policyDecision = {
  id: randomUUID(),
  projectId: action.projectId,
  actionId: action.id,
  actionDigestSha256: digest,
  policyId: "agentcert.default.v1",
  policyVersion: "agentcert.default.v1",
  result: "ALLOW",
  reasonCodes: ["human_approval_satisfied"],
  humanReadableExplanation: "The bound approval satisfies policy.",
  obligations: [],
  requiredApprovers: [],
  evaluatedContextDigest: createHash("sha256").update("example-context").digest("hex"),
  evaluatedAt: "2026-07-22T12:01:00.000Z",
  evaluatorIdentity: "agentcert-control-plane",
};
const approval = {
  id: randomUUID(),
  projectId: action.projectId,
  actionId: action.id,
  reviewerId: "claims-manager",
  decision: "APPROVED",
  actionDigestSha256: digest,
  createdAt: "2026-07-22T12:01:00.000Z",
};
const receipt = createActionAssuranceReceipt({
  action,
  policyDecision,
  approvals: [approval],
  evidence: [],
  enforcementProof: {
    level: "ENFORCED",
    method: "SIGNED_ADAPTER",
    verified: true,
    adapterId: "sandbox-claims-gateway",
    executionGrantDigest: createHash("sha256").update("example-grant").digest("hex"),
    actionEventChainDigest: createHash("sha256").update("example-chain").digest("hex"),
  },
  issuerId: "agentcert-control-plane",
  signer,
  validUntil: "2026-08-22T12:00:00.000Z",
  now: new Date("2026-07-22T12:02:00.000Z"),
});

function withStatus(source, currentStatus) {
  const core = { ...source.core, currentStatus };
  return {
    core,
    coreSha256: createHash("sha256").update(canonicalJson(core)).digest("hex"),
    signatureSet: [signer.attestCanonical(core, core.issuedAt)],
  };
}

const tampered = structuredClone(receipt);
tampered.core.actionId = "tampered-action-id";
const fixtures = [
  ["valid/enforced-receipt.json", receipt],
  ["invalid/tampered-receipt.json", tampered],
  ["revoked/revoked-receipt.json", withStatus(receipt, "REVOKED")],
  ["disputed/disputed-receipt.json", withStatus(receipt, "DISPUTED")],
  ["trust-bundle.json", { [signer.keyId]: signer.publicKeyPem }],
];

for (const [relativePath, value] of fixtures) {
  const path = resolve(outputRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
