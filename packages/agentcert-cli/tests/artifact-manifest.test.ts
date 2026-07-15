import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildArtifactManifest, serializeHostedEvidenceBundle } from "../src/artifact-manifest.js";
import type { PreparedCompanionArtifact } from "../src/companion-artifacts.js";
import type { AgentCertBundle } from "../src/types.js";

describe("artifact manifest", () => {
  it("declares normalized paths, SHA-256, byte size, and kind in stable order", () => {
    const artifacts = [artifact("trace.json", "trace", "trace"), artifact(".\\screenshots\\step.png", "screenshot", "png")];
    expect(buildArtifactManifest(artifacts)).toEqual({
      schemaVersion: "agentcert.artifact_manifest.v0.1",
      entries: [
        {
          path: "screenshots/step.png",
          sha256: createHash("sha256").update("png").digest("hex"),
          sizeBytes: 3,
          kind: "screenshot",
        },
        {
          path: "trace.json",
          sha256: createHash("sha256").update("trace").digest("hex"),
          sizeBytes: 5,
          kind: "trace",
        },
      ],
    });
  });

  it("serializes the declaration into the exact hosted bundle bytes", () => {
    const hosted = serializeHostedEvidenceBundle(bundle(), [artifact("trace.json", "trace", "trace")]);
    const parsed = JSON.parse(new TextDecoder().decode(hosted.bytes));
    expect(parsed.artifactManifest).toEqual(hosted.bundle.artifactManifest);
    expect(parsed.artifactManifest.entries[0]).toMatchObject({ path: "trace.json", sizeBytes: 5, kind: "trace" });
  });

  it("rejects paths that cannot be safely reconciled", () => {
    expect(() => buildArtifactManifest([artifact("../outside.json", "json", "{}")])).toThrow("parent segments");
  });
});

function artifact(sourcePath: string, kind: string, value: string): PreparedCompanionArtifact {
  return { sourcePath, fileName: sourcePath.split(/[\\/]/).at(-1) ?? "artifact", kind, contentType: "application/json", bytes: Buffer.from(value) };
}

function bundle(): AgentCertBundle {
  return {
    schemaName: "agentcert.evidence_bundle", schemaVersion: "agentcert.evidence.v0.1", schemaSemver: "0.1.0",
    kind: "agentcert.evidence_bundle", runId: "run-1", generatedAt: "2026-07-15T00:00:00.000Z",
    subject: { name: "agent", type: "agent" }, verdict: { passed: true, score: 100, level: "pass" },
    summary: { products: ["tripwire-ci"], criticalEvidence: 0, highEvidence: 0, totalEvidence: 0 },
    results: [], evidence: [], artifacts: {}, standards: [],
  };
}
