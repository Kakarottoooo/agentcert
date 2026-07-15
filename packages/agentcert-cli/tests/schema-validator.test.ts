import { describe, expect, it } from "vitest";
import { validateAgentCertSchema } from "../src/schema-validator.js";

describe("AgentCert schema validator", () => {
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
});
