import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const AGENTCERT_SIGNATURE_SCHEMA_VERSION = "agentcert.evidence_signature.v0.1" as const;

export interface AgentCertEvidenceSignature {
  schemaVersion: typeof AGENTCERT_SIGNATURE_SCHEMA_VERSION;
  kind: "agentcert.evidence_signature";
  algorithm: "Ed25519";
  keyId: string;
  signedAt: string;
  artifactPath: string;
  artifactSha256: string;
  signature: string;
}

export interface EvidenceVerificationResult {
  valid: boolean;
  digestMatches: boolean;
  signatureMatches: boolean;
  keyIdMatches: boolean;
  artifactSha256: string;
  keyId: string;
}

export async function generateEvidenceSigningKeyPair(privateKeyPath: string, publicKeyPath: string): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await Promise.all([
    writePrivateFile(privateKeyPath, privateKey),
    writePublicFile(publicKeyPath, publicKey),
  ]);
}

export async function signEvidenceFile(
  artifactPath: string,
  privateKeyPath: string,
  signaturePath = `${artifactPath}.sig.json`,
): Promise<AgentCertEvidenceSignature> {
  const [artifact, privatePem] = await Promise.all([readFile(resolve(artifactPath)), readFile(resolve(privateKeyPath), "utf8")]);
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  const envelope: AgentCertEvidenceSignature = {
    schemaVersion: AGENTCERT_SIGNATURE_SCHEMA_VERSION,
    kind: "agentcert.evidence_signature",
    algorithm: "Ed25519",
    keyId: keyId(publicKey),
    signedAt: new Date().toISOString(),
    artifactPath: artifactPath.replace(/\\/g, "/"),
    artifactSha256: sha256(artifact),
    signature: sign(null, artifact, privateKey).toString("base64"),
  };
  const resolvedSignaturePath = resolve(signaturePath);
  await mkdir(dirname(resolvedSignaturePath), { recursive: true });
  await writeFile(resolvedSignaturePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

export async function verifyEvidenceFile(
  artifactPath: string,
  signaturePath: string,
  publicKeyPath: string,
): Promise<EvidenceVerificationResult> {
  const [artifact, signatureRaw, publicPem] = await Promise.all([
    readFile(resolve(artifactPath)),
    readFile(resolve(signaturePath), "utf8"),
    readFile(resolve(publicKeyPath), "utf8"),
  ]);
  const envelope = JSON.parse(signatureRaw) as AgentCertEvidenceSignature;
  const errors = validateEvidenceSignature(envelope);
  if (errors.length > 0) throw new Error(`Invalid evidence signature: ${errors.join(" ")}`);
  const publicKey = createPublicKey(publicPem);
  const artifactSha256 = sha256(artifact);
  const actualKeyId = keyId(publicKey);
  const digestMatches = envelope.artifactSha256 === artifactSha256;
  const keyIdMatches = envelope.keyId === actualKeyId;
  const signatureMatches = verify(null, artifact, publicKey, Buffer.from(envelope.signature, "base64"));
  return { valid: digestMatches && signatureMatches && keyIdMatches, digestMatches, signatureMatches, keyIdMatches, artifactSha256, keyId: actualKeyId };
}

export function validateEvidenceSignature(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["$ must be an object."];
  const value = input as Record<string, unknown>;
  const errors: string[] = [];
  if (value.schemaVersion !== AGENTCERT_SIGNATURE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${JSON.stringify(AGENTCERT_SIGNATURE_SCHEMA_VERSION)}.`);
  if (value.kind !== "agentcert.evidence_signature") errors.push('kind must be "agentcert.evidence_signature".');
  if (value.algorithm !== "Ed25519") errors.push('algorithm must be "Ed25519".');
  for (const field of ["keyId", "signedAt", "artifactPath", "artifactSha256", "signature"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) errors.push(`${field} must be a non-empty string.`);
  }
  return errors;
}

function keyId(publicKey: ReturnType<typeof createPublicKey>): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${sha256(der).slice(0, 32)}`;
}

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, { mode: 0o600, flag: "wx" });
}

async function writePublicFile(path: string, content: string): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, { flag: "wx" });
}
