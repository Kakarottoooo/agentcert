import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEvidenceArtifacts } from "../src/artifact-validation.js";

describe("evidence artifact validation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentcert-artifacts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("checks bundle, result, and product-scoped evidence artifact paths", async () => {
    await mkdir(join(dir, ".agentcert", "latest"), { recursive: true });
    await mkdir(join(dir, ".tripwire", "latest", "screenshots"), { recursive: true });
    await writeFile(join(dir, ".agentcert", "latest", "report.html"), "<html></html>");
    await writeFile(join(dir, ".tripwire", "latest", "tripwire-result.json"), "{}");
    await writeFile(join(dir, ".tripwire", "latest", "screenshots", "step-1.png"), "png");

    const result = await validateEvidenceArtifacts(
      {
        artifacts: {
          htmlReport: ".agentcert/latest/report.html",
          external: "https://example.com/report",
        },
        results: [
          {
            product: "tripwire-ci",
            artifacts: {
              outDir: ".tripwire/latest",
              result: ".tripwire/latest/tripwire-result.json",
            },
          },
        ],
        evidence: [
          {
            source: "tripwire-ci",
            artifactPath: "screenshots/step-1.png",
          },
        ],
      },
      dir,
    );

    expect(result).toEqual({ checked: 4, missing: [] });
  });

  it("reports missing local artifact paths without treating URLs as files", async () => {
    const result = await validateEvidenceArtifacts(
      {
        artifacts: {
          badge: ".agentcert/latest/missing-badge.svg",
          url: "https://example.com/badge.svg",
        },
        evidence: [
          {
            source: "tripwire-ci",
            artifactPath: ".tripwire/latest/missing-dom.html",
          },
        ],
      },
      dir,
    );

    expect(result.checked).toBe(2);
    expect(result.missing).toEqual([".agentcert/latest/missing-badge.svg", ".tripwire/latest/missing-dom.html"]);
  });
});
