export type AssuranceVerdict = "RELEASE" | "RELEASE_WITH_CONTROLS" | "BLOCK";

export interface AssuranceIssueDraft {
  reason: string;
  publish: boolean;
  engagement: boolean;
  verdict?: string;
  observedOutcomeJson?: string;
  outcomeVerified?: boolean;
  rationale?: string;
  firstDivergence?: string;
  authorizationGaps?: string;
  controlsRequired?: string;
  limitations?: string;
}

export function buildAssuranceIssueInput(draft: AssuranceIssueDraft): Record<string, unknown> {
  const reason = requiredText(draft.reason, "Review reason");
  const input: Record<string, unknown> = { reason, publish: draft.publish };
  if (!draft.engagement) return input;

  const verdict = assuranceVerdict(draft.verdict);
  const observed = observedOutcome(draft.observedOutcomeJson);
  const controlsRequired = lines(draft.controlsRequired);
  const limitations = lines(draft.limitations);
  if (limitations.length === 0) throw new Error("At least one review limitation is required.");
  if (verdict === "RELEASE" && !draft.outcomeVerified) {
    throw new Error("RELEASE requires an independently verified outcome.");
  }
  if (verdict === "RELEASE" && controlsRequired.length > 0) {
    throw new Error("Use RELEASE_WITH_CONTROLS when controls remain required.");
  }
  if (verdict === "RELEASE_WITH_CONTROLS" && controlsRequired.length === 0) {
    throw new Error("RELEASE_WITH_CONTROLS requires at least one declared control.");
  }

  return {
    ...input,
    verdict,
    rationale: requiredText(draft.rationale, "Decision rationale"),
    firstDivergence: requiredText(draft.firstDivergence, "First behavior divergence"),
    authorizationGaps: lines(draft.authorizationGaps),
    controlsRequired,
    limitations,
    outcome: { observed, verified: Boolean(draft.outcomeVerified) },
  };
}

function assuranceVerdict(value?: string): AssuranceVerdict {
  if (value === "RELEASE" || value === "RELEASE_WITH_CONTROLS" || value === "BLOCK") return value;
  throw new Error("Choose RELEASE, RELEASE_WITH_CONTROLS, or BLOCK.");
}

function observedOutcome(value?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value?.trim() || "");
  } catch {
    throw new Error("Observed outcome must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("Observed outcome must be a non-empty JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredText(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function lines(value?: string): string[] {
  return [...new Set((value ?? "").split("\n").map((item) => item.trim()).filter(Boolean))];
}
