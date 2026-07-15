import { describe, expect, it } from "vitest";
import { artifactPointers, findingsForBundle, firstDivergence, parseEvidenceBundle } from "../src/evidence-analysis";

const document = {
  schemaName: "agentcert.evidence_bundle",
  schemaVersion: "agentcert.evidence.v0.1",
  runId: "run-1",
  generatedAt: "2026-07-15T00:00:00.000Z",
  subject: { name: "browser-agent", type: "agent" },
  verdict: { passed: false, score: 0.4, level: "fail" },
  summary: { products: ["tripwire-ci"], criticalEvidence: 0, highEvidence: 1, totalEvidence: 1 },
  results: [{ product: "tripwire-ci", runId: "trip-1", timestamp: "2026-07-15T00:00:00.000Z", phase: "pre-release", score: 0.4, passed: false, artifacts: { trace: "trace.json" }, evidence: [] }],
  evidence: [{ id: "finding-1", kind: "button-text-drift", severity: "high", message: "Button was renamed before the assertion failed.", artifactPath: "screenshots/step-4.png" }],
  artifacts: { result: "tripwire-result.json" },
  standards: [],
};

describe("hosted evidence analysis", () => {
  it("normalizes a v0.1 evidence bundle into reviewable findings and artifact pointers", () => {
    const bundle = parseEvidenceBundle(document);
    expect(bundle?.subject.name).toBe("browser-agent");
    expect(findingsForBundle(bundle, [review])).toEqual([
      expect.objectContaining({ patternKey: "finding-1", suggestedType: "ui_drift", review }),
    ]);
    expect(artifactPointers(bundle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "screenshots/step-4.png", kind: "screenshot" }),
      expect.objectContaining({ path: "trace.json", kind: "trace" }),
    ]));
  });

  it("rejects unrelated JSON instead of presenting it as AgentCert evidence", () => {
    expect(parseEvidenceBundle({ kind: "random-report" })).toBeUndefined();
  });

  it("prefers a human-reviewed first divergence over generated incident text", () => {
    const incident = {
      id: "incident-1", projectId: "project-1", runId: "run-1", severity: "high", type: "run_failure",
      status: "open", summary: "Run failed.", firstDivergence: "incident", createdAt: "2026-07-15T00:00:00.000Z",
    };
    expect(firstDivergence([review], [incident], [], [])).toBe("Agent selected Cancel at step 4.");
  });
});

const review = {
  id: "review-1", projectId: "project-1", runId: "run-1", patternKey: "finding-1", suggestedType: "ui_drift",
  type: "ui_drift", status: "confirmed" as const, reviewer: "reviewer@example.com", confidence: 0.9,
  evidenceContext: { firstDivergenceSnippet: "Agent selected Cancel at step 4.", stepIndex: 4 },
  taxonomyRationale: { primaryReason: "The label changed before the click.", supportingSignals: [], contradictingSignals: [] },
  createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z",
};
