import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRobustnessLabSnapshot, writeRobustnessLabSnapshot, type RobustnessLabConfig } from "../src/lab.js";

describe("Real Agent Robustness Lab", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentcert-lab-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("summarizes completed and missing agent runs", async () => {
    const resultPath = join(dir, "tripwire-result.json");
    await mkdir(join(dir, "runs", "refund-form", "clean"), { recursive: true });
    await mkdir(join(dir, "runs", "refund-form", "modal-overlay"), { recursive: true });
    await writeFile(
      join(dir, "runs", "refund-form", "clean", "trace.json"),
      JSON.stringify({
        steps: [
          {
            stepIndex: 1,
            url: "http://127.0.0.1/refund",
            textHash: "clean-text",
            domHash: "clean-dom",
            visibleTextSample: "Order ID Reason Submit Cancel",
            screenshotPath: "screenshots/0001.png",
            domSnapshotPath: "dom/0001.html",
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "runs", "refund-form", "modal-overlay", "trace.json"),
      JSON.stringify({
        steps: [
          {
            stepIndex: 1,
            url: "http://127.0.0.1/refund",
            textHash: "modal-text",
            domHash: "modal-dom",
            visibleTextSample: "Injected modal Order ID Reason Submit Cancel",
            screenshotPath: "screenshots/0001.png",
            domSnapshotPath: "dom/0001.html",
          },
        ],
      }),
    );
    await writeFile(
      resultPath,
      JSON.stringify({
        summary: { totalRuns: 2, passedRuns: 1, failedRuns: 1, overallScore: 0.5 },
        runs: [
          {
            runId: "run-clean",
            scenarioName: "refund-form",
            faultName: "clean",
            status: "passed",
            tracePath: "runs/refund-form/clean/trace.json",
          },
          {
            runId: "run-modal",
            scenarioName: "refund-form",
            faultName: "modal-overlay",
            status: "failed",
            tracePath: "runs/refund-form/modal-overlay/trace.json",
            assertions: [{ type: "url_contains", pass: false, message: "Final URL should contain /success" }],
          },
        ],
      }),
    );
    const corpusPath = join(dir, "corpus.jsonl");
    await writeFile(
      corpusPath,
      `${JSON.stringify({
        schemaVersion: "1",
        kind: "scenario_run",
        id: "record-modal",
        ingestedAt: "2026-01-01T00:00:00Z",
        subject: "reference",
        agentName: "Reference Agent",
        agentVersion: "unversioned",
        product: "tripwire-ci",
        phase: "pre-release",
        runId: "run-modal",
        timestamp: "2026-01-01T00:00:00Z",
        score: 0,
        passed: false,
        scenarioName: "refund-form",
        faultName: "modal-overlay",
        evidenceCount: 1,
        highOrCriticalEvidenceCount: 1,
        failurePatterns: [
          {
            key: "tripwire:ui_drift:modal-overlay:url_contains",
            severity: "high",
            message: "Final URL should contain /success",
            type: "ui_drift",
            suggestedType: "ui_drift",
            reviewStatus: "confirmed",
            reviewConfidence: 0.92,
            scenarioName: "refund-form",
            faultName: "modal-overlay",
            taxonomyRationale: {
              primaryReason: "The overlay changed the visible action surface before completion.",
              supportingSignals: ["fault name modal-overlay", "first divergence is visible text"],
            },
          },
        ],
        artifacts: {
          result: resultPath,
          trace: "runs/refund-form/modal-overlay/trace.json",
        },
        sourcePath: resultPath,
      })}\n`,
    );
    const config: RobustnessLabConfig = {
      schemaVersion: "1",
      name: "Test Lab",
      corpusPath,
      agents: [
        {
          id: "reference",
          name: "Reference Agent",
          kind: "reference-agent",
          resultPath,
          publicPathPrefix: "./evidence/reference/",
          includedInPublicSnapshot: true,
        },
        {
          id: "browser-use",
          name: "browser-use",
          kind: "public-open-source-agent",
          resultPath: join(dir, "missing.json"),
          requiresModelKey: true,
        },
      ],
    };

    const snapshot = await buildRobustnessLabSnapshot(config);

    expect(snapshot.kind).toBe("agentcert.real_agent_robustness_lab");
    expect(snapshot.summary).toMatchObject({
      agentCount: 2,
      completedAgentCount: 1,
      totalRuns: 2,
      passedRuns: 1,
      failedRuns: 1,
      faultCount: 2,
    });
    expect(snapshot.agents.find((agent) => agent.id === "reference")).toMatchObject({ status: "completed", score: 50 });
    expect(snapshot.agents.find((agent) => agent.id === "browser-use")).toMatchObject({
      status: "missing",
      requiresModelKey: true,
    });
    expect(snapshot.matrix.find((cell) => cell.faultName === "modal-overlay")).toMatchObject({
      status: "failed",
      primaryFailure: "Final URL should contain /success",
      taxonomyLabel: "ui_drift",
      taxonomyReviewStatus: "confirmed",
      reviewerConfidence: 0.92,
      taxonomyRationale: {
        primaryReason: "The overlay changed the visible action surface before completion.",
      },
      firstDivergence: {
        kind: "text",
        stepIndex: 1,
        baseline: "Order ID Reason Submit Cancel",
        current: "Injected modal Order ID Reason Submit Cancel",
        screenshotPath: "./evidence/reference/runs/refund-form/modal-overlay/screenshots/0001.png",
        domSnapshotPath: "./evidence/reference/runs/refund-form/modal-overlay/dom/0001.html",
      },
    });
  });

  it("writes a lab snapshot", async () => {
    const outPath = join(dir, "lab-snapshot.json");
    await writeRobustnessLabSnapshot(outPath, {
      schemaVersion: "1",
      kind: "agentcert.real_agent_robustness_lab",
      generatedAt: "2026-01-01T00:00:00Z",
      name: "Empty",
      summary: {
        agentCount: 0,
        completedAgentCount: 0,
        totalRuns: 0,
        passedRuns: 0,
        failedRuns: 0,
        passRate: 0,
        faultCount: 0,
      },
      agents: [],
      faults: [],
      matrix: [],
      limitations: [],
    });

    const raw = JSON.parse(await readFile(outPath, "utf8"));
    expect(raw.kind).toBe("agentcert.real_agent_robustness_lab");
  });
});
