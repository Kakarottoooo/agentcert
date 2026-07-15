import { describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../src/bundle.js";
import { normalizeMcpBenchResult, normalizeOnegentAuditPacket, normalizeTripwireResult } from "../src/normalizers.js";

describe("AgentCert evidence normalization", () => {
  it("normalizes MCPBench results into pre-release AgentCert results", () => {
    const result = normalizeMcpBenchResult(
      {
        run_id: "run_demo",
        total_score: 100,
        cert_level: "Platinum",
        passed: true,
        violations: [],
        artifact_paths: { report: "report.md" },
        completed_at: "2026-01-01T00:00:00Z",
      },
      "results.json",
    );

    expect(result.product).toBe("mcpbench");
    expect(result.phase).toBe("pre-release");
    expect(result.score).toBe(100);
    expect(result.passed).toBe(true);
  });

  it("normalizes failed Tripwire assertions as high-severity evidence", () => {
    const result = normalizeTripwireResult(
      {
        timestamp: "2026-01-01T00:00:00Z",
        gate: { passed: false },
        summary: { overallScore: 0.5 },
        runs: [
          {
            scenarioName: "checkout",
            faultName: "prompt-injection-banner",
            tracePath: "trace.json",
            assertions: [{ pass: false, message: "Sensitive text leaked" }],
          },
        ],
      },
      "tripwire-result.json",
    );

    expect(result.product).toBe("tripwire-ci");
    expect(result.score).toBe(50);
    expect(result.passed).toBe(false);
    expect(result.evidence[0]).toMatchObject({
      severity: "high",
      message: "Sensitive text leaked",
    });
  });

  it("normalizes Onegent audit packets as runtime evidence", () => {
    const result = normalizeOnegentAuditPacket(
      {
        actionIntent: { id: "act_1" },
        riskAssessment: { riskLevel: "HIGH" },
        approvalRequest: { status: "APPROVED" },
        verificationResult: { success: true, createdAt: "2026-01-01T00:00:00Z" },
        auditEvents: [{ id: "audit_1", message: "Human approval requested." }],
      },
      "audit-packet.json",
    );

    expect(result.product).toBe("onegent-runtime");
    expect(result.phase).toBe("runtime");
    expect(result.passed).toBe(true);
    expect(result.evidence.map((item) => item.kind)).toContain("approval_record");
  });

  it("builds a unified bundle from multiple products", () => {
    const mcpbench = normalizeMcpBenchResult({ run_id: "run_1", total_score: 100, passed: true }, "results.json");
    const onegent = normalizeOnegentAuditPacket(
      {
        actionIntent: { id: "act_1" },
        riskAssessment: { riskLevel: "HIGH" },
        approvalRequest: { status: "APPROVED" },
        verificationResult: { success: true },
      },
      "audit-packet.json",
    );

    const bundle = buildEvidenceBundle([mcpbench, onegent], "demo-agent", "agent");

    expect(bundle.schemaName).toBe("agentcert.evidence_bundle");
    expect(bundle.schemaVersion).toBe("agentcert.evidence.v0.1");
    expect(bundle.schemaSemver).toBe("0.1.0");
    expect(bundle.kind).toBe("agentcert.evidence_bundle");
    expect(bundle.subject.name).toBe("demo-agent");
    expect(bundle.verdict.passed).toBe(true);
    expect(bundle.summary.products).toEqual(["mcpbench", "onegent-runtime"]);
  });
});
