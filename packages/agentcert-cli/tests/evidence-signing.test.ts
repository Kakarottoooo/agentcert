import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateEvidenceSigningKeyPair,
  signEvidenceFile,
  validateEvidenceSignature,
  verifyEvidenceFile,
} from "../src/evidence-signing.js";

describe("AgentCert evidence signing", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentcert-signing-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("signs and verifies an evidence artifact with Ed25519", async () => {
    const privateKey = join(dir, "private.pem");
    const publicKey = join(dir, "public.pem");
    const artifact = join(dir, "evidence.json");
    const signaturePath = join(dir, "evidence.sig.json");
    await writeFile(artifact, '{"kind":"agentcert.evidence_bundle"}\n');
    await generateEvidenceSigningKeyPair(privateKey, publicKey);

    const signature = await signEvidenceFile(artifact, privateKey, signaturePath);
    const result = await verifyEvidenceFile(artifact, signaturePath, publicKey);

    expect(validateEvidenceSignature(signature)).toEqual([]);
    expect(signature.algorithm).toBe("Ed25519");
    expect(signature.artifactSha256).toHaveLength(64);
    expect(result.valid).toBe(true);
    expect(await readFile(publicKey, "utf8")).toContain("BEGIN PUBLIC KEY");
  });

  it("detects evidence changed after signing", async () => {
    const privateKey = join(dir, "private.pem");
    const publicKey = join(dir, "public.pem");
    const artifact = join(dir, "evidence.json");
    const signaturePath = join(dir, "evidence.sig.json");
    await writeFile(artifact, "original\n");
    await generateEvidenceSigningKeyPair(privateKey, publicKey);
    await signEvidenceFile(artifact, privateKey, signaturePath);
    await writeFile(artifact, "tampered\n");

    const result = await verifyEvidenceFile(artifact, signaturePath, publicKey);

    expect(result.valid).toBe(false);
    expect(result.digestMatches).toBe(false);
    expect(result.signatureMatches).toBe(false);
  });
});
