import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEvidenceConformance } from "../src/conformance.js";

describe("evidence conformance suite v0.1", () => {
  let directory: string;
  let bytes: Buffer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentcert-conformance-"));
    bytes = Buffer.from('{"step":1}\n');
    await writeFile(join(directory, "trace.json"), bytes);
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it("accepts a compatible bundle whose manifest exactly matches artifact bytes", async () => {
    const report = await runEvidenceConformance(bundle(), {
      evidenceFile: join(directory, "evidence.json"), artifactRoot: directory, implementation: "reference-adapter",
      now: new Date("2026-07-15T00:00:00.000Z"),
    });
    expect(report).toMatchObject({
      schemaVersion: "agentcert.conformance.v0.1", implementation: "reference-adapter", valid: true,
      summary: { passed: 4, failed: 0 },
    });
  });

  it("keeps the checked-in example byte-stable across platforms", async () => {
    const evidenceFile = fileURLToPath(new URL("../../../examples/conformance/evidence.valid.json", import.meta.url));
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    const report = await runEvidenceConformance(evidence, {
      evidenceFile,
      artifactRoot: join(dirname(evidenceFile), "artifacts"),
      implementation: "checked-in-example",
    });
    expect(report.valid).toBe(true);
  });

  it("reports hash, size, missing-manifest, path, and compatibility failures", async () => {
    const mismatch = bundle();
    mismatch.artifactManifest.entries[0]!.sha256 = "00".repeat(32);
    mismatch.artifactManifest.entries[0]!.sizeBytes = 999;
    const mismatchReport = await runEvidenceConformance(mismatch, { evidenceFile: "evidence.json", artifactRoot: directory });
    expect(mismatchReport.valid).toBe(false);
    expect(mismatchReport.checks.find((item) => item.id === "artifact-bytes")?.errors).toEqual([
      "trace.json: expected 999 bytes, observed 11.",
      "trace.json: SHA-256 does not match the declared digest.",
    ]);

    const missing = { ...bundle(), artifactManifest: undefined, extension: true };
    const missingReport = await runEvidenceConformance(missing, { evidenceFile: "evidence.json", artifactRoot: directory });
    expect(missingReport.checks.find((item) => item.id === "compatibility")?.errors).toContain("Unsupported top-level field: extension.");
    expect(missingReport.checks.find((item) => item.id === "manifest")?.errors).toContain("artifactManifest is required for conformance.");

    const unsafe = bundle();
    unsafe.artifactManifest.entries[0]!.path = "../trace.json";
    const unsafeReport = await runEvidenceConformance(unsafe, { evidenceFile: "evidence.json", artifactRoot: directory });
    expect(unsafeReport.checks.find((item) => item.id === "manifest")?.status).toBe("failed");
  });

  function bundle() {
    return {
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      schemaSemver: "0.1.0",
      kind: "agentcert.evidence_bundle",
      runId: "conformance-run",
      generatedAt: "2026-07-15T00:00:00.000Z",
      subject: { name: "third-party", type: "agent" },
      verdict: { passed: true, score: 100, level: "pass" },
      summary: { products: [], criticalEvidence: 0, highEvidence: 0, totalEvidence: 1 },
      results: [], evidence: [], artifacts: { trace: "trace.json" }, standards: [],
      artifactManifest: {
        schemaVersion: "agentcert.artifact_manifest.v0.1",
        entries: [{
          path: "trace.json", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, kind: "trace",
        }],
      },
    };
  }
});
