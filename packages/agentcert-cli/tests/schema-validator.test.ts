import { describe, expect, it } from "vitest";
import { validateAgentCertSchema } from "../src/schema-validator.js";

describe("AgentCert schema validator", () => {
  it("accepts a minimal evidence bundle", () => {
    const result = validateAgentCertSchema("evidence-bundle", {
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "1",
      schemaSemver: "1.0.0",
      kind: "agentcert.evidence_bundle",
      runId: "run_1",
      generatedAt: "2026-01-01T00:00:00Z",
      subject: { name: "demo-agent", type: "agent" },
      verdict: { passed: true, score: 100, level: "Platinum" },
      summary: { products: [], criticalEvidence: 0, highEvidence: 0, totalEvidence: 0 },
      results: [],
      evidence: [],
      artifacts: {},
      standards: [],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports actionable missing fields", () => {
    const result = validateAgentCertSchema("monitor-snapshot", {
      schemaVersion: "1",
      kind: "agentcert.monitor_snapshot",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("generatedAt must be a non-empty string.");
    expect(result.errors).toContain("summary must be an object.");
  });
});
