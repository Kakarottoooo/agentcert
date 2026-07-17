import { describe, expect, it } from "vitest";
import { validateAgentCertSchema } from "../src/schema-validator.js";

describe("AgentCert schema validator", () => {
  it("validates evidence strength as an explicit ordered claim", () => {
    const result = validateAgentCertSchema("evidence-strength", {
      schemaVersion: "agentcert.evidence_strength.v0.1",
      level: "outcome_verified",
      claims: ["A separate read path observed the expected state."],
      limitations: ["Future behavior is not guaranteed."],
    });
    expect(result).toEqual({ schema: "evidence-strength", valid: true, errors: [] });
  });

  it("accepts a minimal evidence bundle", () => {
    const result = validateAgentCertSchema("evidence-bundle", {
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      schemaSemver: "0.1.0",
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

  it("rejects malformed nested evidence fields", () => {
    const result = validateAgentCertSchema("evidence-bundle", {
      schemaName: "agentcert.evidence_bundle", schemaVersion: "agentcert.evidence.v0.1", schemaSemver: "0.1.0",
      kind: "agentcert.evidence_bundle", runId: "run-1", generatedAt: "not-a-time",
      subject: { name: "", type: "invalid" }, verdict: { passed: "yes", score: 101, level: "pass" },
      summary: { products: [1], criticalEvidence: -1, highEvidence: 0, totalEvidence: 1.5 },
      results: [], evidence: [{ id: "e-1", kind: "trace", severity: "urgent", message: "failure" }],
      artifacts: { trace: 42 }, standards: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "generatedAt must be a valid date-time string.", "subject.name must be a non-empty string.",
      "subject.type must be one of: agent, mcp-server, tool, application, unknown.", "verdict.passed must be a boolean.",
      "verdict.score must be a finite number from 0 to 100.", "evidence[0].severity must be one of: critical, high, medium, low, info.",
      "artifacts.trace must be a string.",
    ]));
  });

  it("accepts classifier evaluation artifacts", () => {
    const result = validateAgentCertSchema("classifier-eval", {
      schemaVersion: "1",
      kind: "agentcert.failure_classifier_evaluation",
      reviewedRows: 2,
      correctRows: 1,
      incorrectRows: 1,
      precision: 0.5,
      coverage: 0.25,
      byType: [{ type: "network_failure", reviewedRows: 1, correctRows: 1, precision: 1 }],
      confusion: [
        {
          suggestedType: "network_failure",
          reviewedType: "console_error",
          count: 1,
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts release-gate and evidence-signature contracts", () => {
    const releaseGate = validateAgentCertSchema("release-gate", {
      schemaVersion: "agentcert.release_gate.v0.1",
      kind: "agentcert.release_gate",
      runId: "gate_1",
      verdict: { passed: true },
      regression: {},
      provenance: {},
      controls: [
        "permission-boundary",
        "data-boundary",
        "tool-contract",
        "state-verification",
        "human-handoff",
        "rate-loop-cost-limits",
        "idempotency-retry-safety",
        "observability-auditability",
        "rollback-kill-switch",
        "supply-chain-dependency-boundary",
      ].map((id) => ({ id, mode: "automated", status: "pass", evidence: [] })),
    });
    const signature = validateAgentCertSchema("evidence-signature", {
      schemaVersion: "agentcert.evidence_signature.v0.1",
      kind: "agentcert.evidence_signature",
      algorithm: "Ed25519",
      keyId: "sha256:abc",
      signedAt: "2026-01-01T00:00:00Z",
      artifactPath: "agentcert-evidence.json",
      artifactSha256: "a".repeat(64),
      signature: "c2lnbmF0dXJl",
    });

    expect(releaseGate.valid).toBe(true);
    expect(signature.valid).toBe(true);
  });

  it("accepts a scoped assurance report", () => {
    const result = validateAgentCertSchema("assurance-report", {
      schemaVersion: "agentcert.assurance_report.v0.1", assuranceCaseId: "case-1", projectId: "project-1",
      subject: { id: "agent-1", name: "Browser Agent", kind: "browser", version: "1.0.0" },
      policyPackVersion: "agentcert.browser.v0.1", evaluationPlanSha256: "a".repeat(64), evidence: [{ id: "e-1" }],
      decision: "issued", reviewerId: "reviewer-1", issuedAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-10-14T00:00:00.000Z",
      limitations: ["Synthetic environment only."], statement: "Scoped assurance decision.",
    });
    expect(result).toEqual({ schema: "assurance-report", valid: true, errors: [] });
  });
});
