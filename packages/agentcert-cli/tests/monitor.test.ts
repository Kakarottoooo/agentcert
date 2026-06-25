import { describe, expect, it } from "vitest";
import { buildMonitorSnapshot } from "../src/monitor.js";
import type { AgentCertCorpusRecord } from "../src/corpus.js";

describe("AgentCert monitor snapshots", () => {
  it("builds lifecycle gate status from corpus records", () => {
    const snapshot = buildMonitorSnapshot(
      [
        record("tripwire-ci", true, "clean"),
        record("tripwire-ci", false, "modal-overlay", "Final URL should contain /success"),
      ],
      { subject: "demo-agent", detailUrl: "../browser-agent-robustness/" },
    );

    expect(snapshot.kind).toBe("agentcert.monitor_snapshot");
    expect(snapshot.subject).toBe("demo-agent");
    expect(snapshot.summary.totalRecords).toBe(2);
    expect(snapshot.filters).toMatchObject({
      agents: ["demo-agent"],
      faults: ["clean", "modal-overlay"],
      versions: ["unversioned"],
      failureTypes: ["ui_drift"],
    });
    expect(snapshot.lifecycle.find((gate) => gate.id === "tripwire-ci")).toMatchObject({
      recordCount: 2,
      passedCount: 1,
      failedCount: 1,
      status: "failing",
    });
    expect(snapshot.lifecycle.find((gate) => gate.id === "mcpbench")).toMatchObject({
      recordCount: 0,
      status: "waiting",
    });
    expect(snapshot.recentRuns[0].faultName).toBe("modal-overlay");
    expect(snapshot.links.detailUrl).toBe("../browser-agent-robustness/");
  });
});

function record(product: AgentCertCorpusRecord["product"], passed: boolean, faultName: string, failure?: string): AgentCertCorpusRecord {
  return {
    schemaVersion: "1",
    kind: "scenario_run",
    id: `${product}_${faultName}`,
    ingestedAt: "2026-01-01T00:00:00Z",
    subject: "demo-agent",
    agentName: "demo-agent",
    agentVersion: "unversioned",
    product,
    phase: product === "onegent-runtime" ? "runtime" : "pre-release",
    runId: `${product}_${faultName}`,
    timestamp: passed ? "2026-01-01T00:00:00Z" : "2026-01-01T00:00:01Z",
    score: passed ? 100 : 0,
    passed,
    scenarioName: "refund-form",
    faultName,
    evidenceCount: failure ? 1 : 0,
    highOrCriticalEvidenceCount: failure ? 1 : 0,
    failurePatterns: failure
      ? [
          {
            key: `${product}:ui_drift:${faultName}:url_contains`,
            severity: "high",
            message: failure,
            type: "ui_drift",
            scenarioName: "refund-form",
            faultName,
          },
        ]
      : [],
    artifacts: { result: "tripwire-result.json" },
    sourcePath: "corpus.jsonl",
  };
}
