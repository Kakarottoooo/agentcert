import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCompanionArtifacts } from "../src/companion-artifacts.js";
import type { AgentCertBundle } from "../src/types.js";

describe("companion artifact collection", () => {
  let parent: string;
  let root: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "agentcert-companions-"));
    root = join(parent, "repo");
    await mkdir(join(root, ".tripwire", "latest", "screenshots"), { recursive: true });
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("collects referenced files, resolves product-relative evidence, and ignores directory metadata", async () => {
    await writeFile(join(root, ".tripwire", "latest", "trace.json"), "trace");
    await writeFile(join(root, ".tripwire", "latest", "screenshots", "step-1.png"), "png");
    const result = await collectCompanionArtifacts(bundle({
      artifacts: {
        trace: ".tripwire/latest/trace.json",
        "tripwire-ci.outDir": ".tripwire/latest",
        remote: "https://example.com/external-report.json",
      },
      results: [{
        ...baseResult,
        artifacts: { outDir: ".tripwire/latest", trace: ".tripwire/latest/trace.json" },
        evidence: [{ ...baseEvidence, artifactPath: "screenshots/step-1.png" }],
      }],
      evidence: [{ ...baseEvidence, artifactPath: "screenshots/step-1.png" }],
    }), root);

    expect(result.artifacts.map((item) => ({ sourcePath: item.sourcePath, kind: item.kind, contentType: item.contentType })))
      .toEqual(expect.arrayContaining([
        { sourcePath: ".tripwire/latest/trace.json", kind: "trace", contentType: "application/json" },
        { sourcePath: "screenshots/step-1.png", kind: "screenshot", contentType: "image/png" },
      ]));
    expect(result.artifacts).toHaveLength(2);
    expect(result.totalBytes).toBe(8);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "https://example.com/external-report.json", reason: "remote_url" }),
    ]));
    expect(result.skipped).toHaveLength(1);
  });

  it("never reads lexical or symlink-resolved paths outside the artifact root", async () => {
    const outside = join(parent, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.json"), "secret");
    await symlink(outside, join(root, "escape"), "junction");
    const result = await collectCompanionArtifacts(bundle({
      artifacts: {
        lexicalEscape: "../outside/secret.json",
        symlinkEscape: "escape/secret.json",
      },
    }), root);

    expect(result.artifacts).toHaveLength(0);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "../outside/secret.json", reason: "outside_artifact_root" }),
      expect.objectContaining({ sourcePath: "escape/secret.json", reason: "outside_artifact_root" }),
    ]));
  });

  it("enforces file count, individual size, and aggregate size without reading oversized files", async () => {
    await Promise.all([
      writeFile(join(root, "a.json"), "aaaa"),
      writeFile(join(root, "b.json"), "bbbb"),
      writeFile(join(root, "large.json"), "123456"),
    ]);
    const sizeLimited = await collectCompanionArtifacts(bundle({
      artifacts: { a: "a.json", b: "b.json", large: "large.json" },
    }), root, { maxFiles: 5, maxFileBytes: 5, maxTotalBytes: 6 });

    expect(sizeLimited.artifacts.map((item) => item.sourcePath)).toEqual(["a.json"]);
    expect(sizeLimited.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "b.json", reason: "total_size_limit" }),
      expect.objectContaining({ sourcePath: "large.json", reason: "file_too_large" }),
    ]));

    const countLimited = await collectCompanionArtifacts(bundle({
      artifacts: { a: "a.json", b: "b.json" },
    }), root, { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 });
    expect(countLimited.artifacts).toHaveLength(1);
    expect(countLimited.skipped).toContainEqual(expect.objectContaining({ sourcePath: "b.json", reason: "file_limit" }));
  });

  it("skips companion files outside the server evidence allowlist", async () => {
    await Promise.all([
      writeFile(join(root, "script.exe"), "MZpayload"),
      writeFile(join(root, "diagram.svg"), "<svg/>"),
      writeFile(join(root, "notes.md"), "# Notes"),
    ]);
    const result = await collectCompanionArtifacts(bundle({
      artifacts: { executable: "script.exe", vector: "diagram.svg", notes: "notes.md" },
    }), root);

    expect(result.artifacts).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ sourcePath: "script.exe", reason: "unsupported_type" }),
      expect.objectContaining({ sourcePath: "diagram.svg", reason: "unsupported_type" }),
      expect.objectContaining({ sourcePath: "notes.md", reason: "unsupported_type" }),
    ]);
  });
});

const baseEvidence = {
  id: "ev-1",
  kind: "wrong_click",
  severity: "high" as const,
  message: "Clicked the wrong control.",
  source: "tripwire-ci",
};

const baseResult = {
  schemaVersion: "1" as const,
  product: "tripwire-ci" as const,
  runId: "tripwire-1",
  timestamp: "2026-07-15T00:00:00.000Z",
  phase: "pre-release" as const,
  score: 0.5,
  passed: false,
  artifacts: {},
  evidence: [],
};

function bundle(overrides: Partial<AgentCertBundle>): AgentCertBundle {
  return {
    schemaName: "agentcert.evidence_bundle",
    schemaVersion: "agentcert.evidence.v0.1",
    schemaSemver: "0.1.0",
    kind: "agentcert.evidence_bundle",
    runId: "run-1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    subject: { name: "browser-agent", type: "agent" },
    verdict: { passed: false, score: 0.5, level: "fail" },
    summary: { products: ["tripwire-ci"], criticalEvidence: 0, highEvidence: 1, totalEvidence: 1 },
    results: [],
    evidence: [],
    artifacts: {},
    standards: [],
    ...overrides,
  };
}
