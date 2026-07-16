import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const SERVER_ATTESTATION_VERSION = "agentcert.server_attestation.v0.1" as const;

export interface ServerAttestation {
  schemaVersion: typeof SERVER_ATTESTATION_VERSION;
  algorithm: "Ed25519";
  keyId: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
}

export interface EvidenceAttestationPayload {
  evidenceId: string;
  projectId: string;
  runId?: string;
  actionId?: string;
  kind: string;
  schemaVersion: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export class EvidenceSigner {
  readonly publicKeyPem: string;
  private readonly privateKey: KeyObject;

  constructor(readonly keyId: string, privateKeyPem: string) {
    if (!keyId.trim()) throw new Error("Evidence signing key ID is required.");
    this.privateKey = createPrivateKey(privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Evidence signing key must be Ed25519.");
    this.publicKeyPem = createPublicKey(this.privateKey).export({ type: "spki", format: "pem" }).toString();
  }

  attest(payload: EvidenceAttestationPayload, signedAt = new Date().toISOString()): ServerAttestation {
    return this.attestCanonical(payload, signedAt);
  }

  attestCanonical(payload: unknown, signedAt = new Date().toISOString()): ServerAttestation {
    const bytes = Buffer.from(canonicalJson(payload));
    return {
      schemaVersion: SERVER_ATTESTATION_VERSION,
      algorithm: "Ed25519",
      keyId: this.keyId,
      signedAt,
      payloadSha256: sha256(bytes),
      signature: sign(null, bytes, this.privateKey).toString("base64url"),
    };
  }
}

export function verifyCanonicalAttestation(payload: unknown, attestation: ServerAttestation, publicKeyPem: string): boolean {
  if (attestation.schemaVersion !== SERVER_ATTESTATION_VERSION || attestation.algorithm !== "Ed25519") return false;
  const bytes = Buffer.from(canonicalJson(payload));
  if (sha256(bytes) !== attestation.payloadSha256) return false;
  try {
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(attestation.signature, "base64url"));
  } catch {
    return false;
  }
}

export function verifyEvidenceAttestation(payload: EvidenceAttestationPayload, attestation: ServerAttestation, publicKeyPem: string): boolean {
  return verifyCanonicalAttestation(payload, attestation, publicKeyPem);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(input).sort().filter((key) => input[key] !== undefined).map((key) => [key, canonicalValue(input[key])]));
  }
  throw new Error(`Canonical JSON does not support ${typeof value}.`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
