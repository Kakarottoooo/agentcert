import { describe, expect, it } from "vitest";
import { JUnitReport } from "../../src/reports/JUnitReport.js";
import type { TripwireResult } from "../../src/types.js";

describe("JUnitReport", () => {
  it("renders basic failure XML", () => {
    const xml = JUnitReport.render({
      version: "0.1",
      project: "demo",
      timestamp: "2026-01-01T00:00:00.000Z",
      outDir: ".tripwire/latest",
      gate: { failUnder: 0.8, passed: false },
      summary: { totalScenarios: 1, totalRuns: 1, passedRuns: 0, failedRuns: 1, overallScore: 0 },
      scenarioScores: [{ scenarioName: "s", score: 0, passedRuns: 0, totalRuns: 1 }],
      runs: [
        {
          runId: "r",
          scenarioName: "s",
          faultName: "clean",
          fault: { name: "clean", type: "none" },
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 12,
          tracePath: "runs/s/clean/trace.json",
          artifactDir: "runs/s/clean/agent-artifacts",
          finalUrl: "http://x",
          agent: { command: "node", args: [], env: {} },
          agentResult: { exitCode: 1, timedOut: false, stdout: "", stderr: "", durationMs: 1 },
          assertions: [{ type: "url_contains", expected: "/success", pass: false, message: "missing", observed: "http://x" }],
          warnings: [],
          diagnostics: [],
          consoleErrors: [],
          networkErrors: [],
          requests: [],
          stepCount: 0
        }
      ]
    } satisfies TripwireResult);
    expect(xml).toContain("<testsuite");
    expect(xml).toContain("<failure");
    expect(xml).toContain("url_contains");
  });
});
