import { describe, expect, it } from "vitest";
import { buildAssuranceIssueInput } from "../src/assurance-issue";

describe("assurance report issuance", () => {
  it("builds a controlled release decision from the structured review fields", () => {
    expect(buildAssuranceIssueInput({
      reason: "  Independent review complete. ",
      publish: false,
      engagement: true,
      verdict: "RELEASE_WITH_CONTROLS",
      observedOutcomeJson: '{"status":"COMPLETED"}',
      outcomeVerified: true,
      rationale: "The retest completed under the declared controls.",
      firstDivergence: "No behavior divergence observed.",
      authorizationGaps: "Missing mandate binding\nMissing mandate binding\n",
      controlsRequired: "Keep the action gateway mandatory.\nRequire approval for SEND.",
      limitations: "Sandbox only.\nPinned agent version.",
    })).toEqual({
      reason: "Independent review complete.",
      publish: false,
      verdict: "RELEASE_WITH_CONTROLS",
      rationale: "The retest completed under the declared controls.",
      firstDivergence: "No behavior divergence observed.",
      authorizationGaps: ["Missing mandate binding"],
      controlsRequired: ["Keep the action gateway mandatory.", "Require approval for SEND."],
      limitations: ["Sandbox only.", "Pinned agent version."],
      outcome: { observed: { status: "COMPLETED" }, verified: true },
    });
  });

  it("rejects missing review rationale before calling the API", () => {
    expect(() => buildAssuranceIssueInput({
      reason: "Review complete.", publish: false, engagement: true, verdict: "BLOCK",
      observedOutcomeJson: '{"status":"FAILED"}', rationale: " ", firstDivergence: "Step 3 diverged.", limitations: "Sandbox only.",
    })).toThrow("Decision rationale is required.");
  });

  it("reports malformed observed outcome JSON clearly", () => {
    expect(() => buildAssuranceIssueInput({
      reason: "Review complete.", publish: false, engagement: true, verdict: "BLOCK",
      observedOutcomeJson: "not-json", rationale: "Unsafe behavior observed.", firstDivergence: "Step 3 diverged.", limitations: "Sandbox only.",
    })).toThrow("Observed outcome must be valid JSON.");
  });

  it("keeps legacy assurance cases on the minimal issue contract", () => {
    expect(buildAssuranceIssueInput({ reason: " Evidence reconciled. ", publish: true, engagement: false })).toEqual({
      reason: "Evidence reconciled.", publish: true,
    });
  });

  it("enforces verdict-specific outcome and control rules", () => {
    const base = {
      reason: "Review complete.", publish: false, engagement: true, observedOutcomeJson: '{"status":"COMPLETED"}',
      rationale: "Evidence reconciled.", firstDivergence: "No behavior divergence observed.", limitations: "Sandbox only.",
    };
    expect(() => buildAssuranceIssueInput({ ...base, verdict: "RELEASE", outcomeVerified: false })).toThrow("RELEASE requires an independently verified outcome.");
    expect(() => buildAssuranceIssueInput({ ...base, verdict: "RELEASE_WITH_CONTROLS", outcomeVerified: true })).toThrow("requires at least one declared control");
  });
});
