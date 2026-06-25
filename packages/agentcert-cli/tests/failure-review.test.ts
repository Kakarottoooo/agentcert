import { describe, expect, it } from "vitest";
import type { AgentCertCorpusRecord } from "../src/corpus.js";
import { applyFailureReviews, createFailureReview, findFailurePattern, parseFailureReviewStatus, parseReviewConfidence } from "../src/failure-review.js";
import { summarizeCorpus } from "../src/corpus.js";

describe("failure taxonomy reviews", () => {
  it("applies human corrections while preserving the automatic suggestion", () => {
    const records = [record()];
    const review = createFailureReview({
      target: {
        recordId: "rec_1",
        patternKey: "tripwire:network_failure:http-failure:no_console_error",
      },
      suggestedType: "network_failure",
      type: "console_error",
      status: "corrected",
      reviewer: "qa@example.com",
      note: "The failing assertion is specifically a console error.",
      confidence: 0.85,
      evidenceContext: {
        firstDivergenceSnippet: "Console displayed a 503 failure before the task completed.",
        screenshotPath: "runs/http-failure/step-2.png",
        tracePath: "runs/http-failure/trace.json",
        stepIndex: 2,
      },
      taxonomyRationale: {
        primaryReason: "The failed assertion is about a browser console error, not the HTTP fault itself.",
        supportingSignals: ["assertion type no_console_error", "observed 503 in console"],
        classifierLimitation: "The automatic rule started from the fault name before assertion semantics.",
      },
      reviewedAt: "2026-01-01T00:00:00Z",
    });

    const [updated] = applyFailureReviews(records, [review]);

    expect(updated.failurePatterns[0]).toMatchObject({
      type: "console_error",
      suggestedType: "network_failure",
      reviewStatus: "corrected",
      reviewer: "qa@example.com",
      reviewNote: "The failing assertion is specifically a console error.",
      reviewConfidence: 0.85,
      reviewEvidenceContext: {
        firstDivergenceSnippet: "Console displayed a 503 failure before the task completed.",
        screenshotPath: "runs/http-failure/step-2.png",
        tracePath: "runs/http-failure/trace.json",
        stepIndex: 2,
      },
      taxonomyRationale: {
        primaryReason: "The failed assertion is about a browser console error, not the HTTP fault itself.",
        supportingSignals: ["assertion type no_console_error", "observed 503 in console"],
        classifierLimitation: "The automatic rule started from the fault name before assertion semantics.",
      },
    });
    expect(updated.metadata?.taxonomyReview).toMatchObject({
      reviewedFailurePatterns: 1,
      correctedFailurePatterns: 1,
      unreviewedFailurePatterns: 0,
    });

    const summary = summarizeCorpus([updated]);
    expect(summary.byFailureType).toEqual([{ key: "console_error", total: 1, passed: 0, failed: 1, passRate: 0 }]);
    expect(summary.taxonomy).toMatchObject({
      totalFailurePatterns: 1,
      reviewedFailurePatterns: 1,
      correctedFailurePatterns: 1,
      unreviewedFailurePatterns: 0,
    });
  });

  it("can find target patterns and infer confirmation status", () => {
    const records = [record()];
    const matched = findFailurePattern(records, {
      runId: "run_1",
      patternKey: "tripwire:network_failure:http-failure:no_console_error",
    });

    expect(matched?.pattern.type).toBe("network_failure");
    expect(parseFailureReviewStatus(undefined, "network_failure", "network_failure")).toBe("confirmed");
    expect(parseFailureReviewStatus(undefined, "console_error", "network_failure")).toBe("corrected");
  });

  it("validates reviewer confidence as a normalized training label score", () => {
    expect(parseReviewConfidence("0.72")).toBe(0.72);
    expect(parseReviewConfidence(1)).toBe(1);
    expect(parseReviewConfidence(undefined)).toBeUndefined();
    expect(() => parseReviewConfidence("1.2")).toThrow("Review confidence must be a number from 0 to 1.");
    expect(() => parseReviewConfidence("not-a-number")).toThrow("Review confidence must be a number from 0 to 1.");
  });
});

function record(): AgentCertCorpusRecord {
  return {
    schemaVersion: "1",
    kind: "scenario_run",
    id: "rec_1",
    ingestedAt: "2026-01-01T00:00:00Z",
    subject: "demo-agent",
    agentName: "brittle agent",
    agentVersion: "unversioned",
    product: "tripwire-ci",
    phase: "pre-release",
    runId: "run_1",
    timestamp: "2026-01-01T00:00:00Z",
    score: 0,
    passed: false,
    scenarioName: "refund-form",
    faultName: "http-failure",
    evidenceCount: 1,
    highOrCriticalEvidenceCount: 1,
    failurePatterns: [
      {
        key: "tripwire:network_failure:http-failure:no_console_error",
        severity: "high",
        message: "No console errors should be recorded",
        type: "network_failure",
        suggestedType: "network_failure",
        reviewStatus: "unreviewed",
        scenarioName: "refund-form",
        faultName: "http-failure",
      },
    ],
    artifacts: { result: "tripwire-result.json" },
    sourcePath: "tripwire-result.json",
  };
}
