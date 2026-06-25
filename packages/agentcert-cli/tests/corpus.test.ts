import { describe, expect, it } from "vitest";
import { recordsFromAgentCertResult, renderCorpusSummary, summarizeCorpus } from "../src/corpus.js";
import { normalizeTripwireResult } from "../src/normalizers.js";
import type { AgentCertResult } from "../src/types.js";

describe("AgentCert corpus", () => {
  it("turns Tripwire runs into queryable scenario records", () => {
    const raw = {
      timestamp: "2026-01-01T00:00:00Z",
      gate: { passed: false },
      summary: { overallScore: 0.5 },
      runs: [
        {
          runId: "run_clean",
          scenarioName: "refund-form",
          faultName: "clean",
          status: "passed",
          startedAt: "2026-01-01T00:00:01Z",
          durationMs: 1000,
          stepCount: 2,
          tracePath: "runs/clean/trace.json",
          artifactDir: "runs/clean",
          finalUrl: "http://127.0.0.1:3020/success",
          assertions: [{ type: "url_contains", pass: true, message: "ok" }],
        },
        {
          runId: "run_modal",
          scenarioName: "refund-form",
          faultName: "modal-overlay",
          status: "failed",
          startedAt: "2026-01-01T00:00:02Z",
          durationMs: 4000,
          stepCount: 5,
          tracePath: "runs/modal/trace.json",
          artifactDir: "runs/modal",
          finalUrl: "http://127.0.0.1:3020/refund",
          assertions: [{ type: "url_contains", pass: false, message: "Expected URL to contain /success" }],
        },
      ],
    };
    const result = normalizeTripwireResult(raw, "tripwire-result.json");
    const records = recordsFromAgentCertResult(result, "tripwire-result.json", "demo-agent", raw, "2026-01-01T00:01:00Z");

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "scenario_run",
      subject: "demo-agent",
      agentName: "demo-agent",
      agentVersion: "unversioned",
      product: "tripwire-ci",
      faultName: "clean",
      passed: true,
      evidenceCount: 0,
    });
    expect(records[1]).toMatchObject({
      kind: "scenario_run",
      faultName: "modal-overlay",
      passed: false,
      evidenceCount: 1,
      highOrCriticalEvidenceCount: 1,
    });
    expect(records[1].failurePatterns[0]).toMatchObject({
      key: "tripwire:ui_drift:modal-overlay:url_contains",
      type: "ui_drift",
      message: "Expected URL to contain /success",
    });
  });

  it("summarizes pass rates by product, fault, and failure pattern", () => {
    const records = [
      record("clean", true, []),
      record("modal-overlay", false, ["tripwire:modal-overlay:url_contains"]),
      record("button-text-drift", false, ["tripwire:button-text-drift:url_contains"]),
    ];

    const summary = summarizeCorpus(records);

    expect(summary.totalRecords).toBe(3);
    expect(summary.passRate).toBe(1 / 3);
    expect(summary.byProduct).toEqual([{ key: "tripwire-ci", total: 3, passed: 1, failed: 2, passRate: 1 / 3 }]);
    expect(summary.byFault.find((bucket) => bucket.key === "modal-overlay")).toMatchObject({ total: 1, failed: 1 });
    expect(summary.byAgent).toEqual([{ key: "demo-agent", total: 3, passed: 1, failed: 2, passRate: 1 / 3 }]);
    expect(summary.byVersion).toEqual([{ key: "unversioned", total: 3, passed: 1, failed: 2, passRate: 1 / 3 }]);
    expect(summary.byFailureType).toEqual([{ key: "assertion_failure", total: 2, passed: 0, failed: 2, passRate: 0 }]);
    expect(summary.taxonomy).toMatchObject({ totalFailurePatterns: 2, reviewedFailurePatterns: 0, unreviewedFailurePatterns: 2 });
    expect(summary.topFailurePatterns.map((pattern) => pattern.key)).toEqual([
      "tripwire:button-text-drift:url_contains",
      "tripwire:modal-overlay:url_contains",
    ]);
    expect(renderCorpusSummary(summary)).toContain("Total records: 3");
  });

  it("does not treat high-risk evidence on a passing product run as a failure pattern", () => {
    const result: AgentCertResult = {
      schemaVersion: "1",
      product: "onegent-runtime",
      runId: "act_1",
      timestamp: "2026-01-01T00:00:00Z",
      phase: "runtime",
      score: 100,
      passed: true,
      summary: "Runtime action was approved and verified.",
      artifacts: { auditPacket: "audit-packet.json" },
      evidence: [
        {
          id: "risk",
          kind: "runtime_risk_assessment",
          severity: "high",
          message: "Runtime action risk assessed as HIGH.",
          source: "onegent-runtime",
          artifactPath: "audit-packet.json",
        },
      ],
    };

    const [record] = recordsFromAgentCertResult(result, "audit-packet.json", "demo-agent", result, "2026-01-01T00:01:00Z");

    expect(record.passed).toBe(true);
    expect(record.evidenceCount).toBe(1);
    expect(record.highOrCriticalEvidenceCount).toBe(1);
    expect(record.failurePatterns).toEqual([]);
  });
});

function record(faultName: string, passed: boolean, failureKeys: string[]) {
  return {
    schemaVersion: "1" as const,
    kind: "scenario_run" as const,
    id: `id_${faultName}`,
    ingestedAt: "2026-01-01T00:00:00Z",
    subject: "demo-agent",
    agentName: "demo-agent",
    agentVersion: "unversioned",
    product: "tripwire-ci" as const,
    phase: "pre-release" as const,
    runId: `run_${faultName}`,
    timestamp: "2026-01-01T00:00:00Z",
    score: passed ? 100 : 0,
    passed,
    scenarioName: "refund-form",
    faultName,
    evidenceCount: failureKeys.length,
    highOrCriticalEvidenceCount: failureKeys.length,
    failurePatterns: failureKeys.map((key) => ({
      key,
      severity: "high" as const,
      message: `${key} failed`,
      type: "assertion_failure" as const,
      suggestedType: "assertion_failure" as const,
      reviewStatus: "unreviewed" as const,
      scenarioName: "refund-form",
      faultName,
    })),
    artifacts: { result: "tripwire-result.json" },
    sourcePath: "tripwire-result.json",
  };
}
