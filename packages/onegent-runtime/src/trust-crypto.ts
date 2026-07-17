import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { SourceSignature, SourceSigner } from "./trust-types.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function publicKeyPemFor(signer: SourceSigner): string {
  if (signer.publicKeyPem) return normalizePem(signer.publicKeyPem);
  return createPublicKey(createPrivateKey(signer.privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
}

export function publicKeySha256(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return sha256(der);
}

export function signDigest(digest: string, signer: SourceSigner): SourceSignature {
  assertDigest(digest);
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    signature: sign(null, Buffer.from(digest, "hex"), createPrivateKey(signer.privateKeyPem)).toString("base64url"),
  };
}

export function verifyDigest(digest: string, signature: SourceSignature, publicKeyPem: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(digest) || signature.algorithm !== "Ed25519") return false;
  try {
    return verify(null, Buffer.from(digest, "hex"), createPublicKey(publicKeyPem), Buffer.from(signature.signature, "base64url"));
  } catch {
    return false;
  }
}

export function generateSourceSigner(keyId: string): SourceSigner & { publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}.`);
}

function normalizePem(value: string): string {
  return createPublicKey(value).export({ type: "spki", format: "pem" }).toString();
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("A SHA-256 hex digest is required for source signing.");
}
