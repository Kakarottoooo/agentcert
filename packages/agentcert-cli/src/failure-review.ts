import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AgentCertCorpusRecord,
  FailurePattern,
  FailureReviewEvidenceContext,
  FailureReviewStatus,
  FailureTaxonomyRationale,
  FailureType,
} from "./corpus.js";

export const FAILURE_TYPES: FailureType[] = [
  "prompt_injection",
  "wrong_click",
  "timeout",
  "verification_gap",
  "silent_partial_success",
  "network_failure",
  "ui_drift",
  "policy_or_approval",
  "agent_connection",
  "console_error",
  "assertion_failure",
  "unknown_failure",
];

export type HumanFailureReviewStatus = Exclude<FailureReviewStatus, "unreviewed">;

export interface FailureReviewTarget {
  patternKey: string;
  recordId?: string;
  runId?: string;
  product?: string;
  scenarioName?: string;
  faultName?: string;
}

export interface FailureReview {
  schemaVersion: "1";
  kind: "agentcert.failure_review";
  id: string;
  reviewedAt: string;
  reviewer: string;
  status: HumanFailureReviewStatus;
  target: FailureReviewTarget;
  suggestedType?: FailureType;
  type: FailureType;
  note?: string;
  confidence?: number;
  evidenceContext?: FailureReviewEvidenceContext;
  taxonomyRationale?: FailureTaxonomyRationale;
}

export interface CreateFailureReviewInput {
  target: FailureReviewTarget;
  type: FailureType;
  status: HumanFailureReviewStatus;
  reviewer?: string;
  suggestedType?: FailureType;
  note?: string;
  confidence?: number;
  evidenceContext?: FailureReviewEvidenceContext;
  taxonomyRationale?: FailureTaxonomyRationale;
  reviewedAt?: string;
}

export function createFailureReview(input: CreateFailureReviewInput): FailureReview {
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  const reviewer = input.reviewer ?? "human-reviewer";
  const confidence = normalizeReviewConfidence(input.confidence);
  const id = stableReviewId({
    reviewedAt,
    reviewer,
    target: input.target,
    type: input.type,
    status: input.status,
  });
  return {
    schemaVersion: "1",
    kind: "agentcert.failure_review",
    id,
    reviewedAt,
    reviewer,
    status: input.status,
    target: input.target,
    suggestedType: input.suggestedType,
    type: input.type,
    note: input.note,
    confidence,
    evidenceContext: input.evidenceContext,
    taxonomyRationale: input.taxonomyRationale,
  };
}

export function parseFailureType(input: string | undefined): FailureType {
  if (input && (FAILURE_TYPES as string[]).includes(input)) {
    return input as FailureType;
  }
  throw new Error(`Unknown failure type "${input ?? ""}". Use one of: ${FAILURE_TYPES.join(", ")}.`);
}

export function parseFailureReviewStatus(input: string | undefined, type: FailureType, suggestedType?: FailureType): HumanFailureReviewStatus {
  if (input === "confirmed" || input === "corrected") {
    return input;
  }
  return suggestedType && type === suggestedType ? "confirmed" : "corrected";
}

export function parseReviewConfidence(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  const value = typeof input === "number" ? input : Number(input);
  return normalizeReviewConfidence(value);
}

export async function readFailureReviews(path: string | undefined): Promise<FailureReview[]> {
  if (!path) return [];
  try {
    const raw = await readFile(resolve(path), "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FailureReview)
      .filter((review) => review.kind === "agentcert.failure_review");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function appendFailureReview(path: string, review: FailureReview): Promise<void> {
  const outPath = resolve(path);
  await mkdir(dirname(outPath), { recursive: true });
  const existing = await readFile(outPath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  const prefix = existing.trimEnd();
  const separator = prefix.length > 0 ? "\n" : "";
  await writeFile(outPath, `${prefix}${separator}${JSON.stringify(review)}\n`);
}

export function applyFailureReviews(records: AgentCertCorpusRecord[], reviews: FailureReview[]): AgentCertCorpusRecord[] {
  if (reviews.length === 0) {
    return records.map(normalizeRecordReviewState);
  }

  const sortedReviews = [...reviews].sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt));
  return records.map((record) => {
    const failurePatterns = record.failurePatterns.map((pattern) => applyReviewToPattern(record, pattern, sortedReviews));
    return {
      ...record,
      failurePatterns,
      metadata: {
        ...record.metadata,
        taxonomyReview: {
          reviewedFailurePatterns: failurePatterns.filter((pattern) => pattern.reviewStatus === "confirmed" || pattern.reviewStatus === "corrected").length,
          correctedFailurePatterns: failurePatterns.filter((pattern) => pattern.reviewStatus === "corrected").length,
          unreviewedFailurePatterns: failurePatterns.filter((pattern) => (pattern.reviewStatus ?? "unreviewed") === "unreviewed").length,
        },
      },
    };
  });
}

export function findFailurePattern(
  records: AgentCertCorpusRecord[],
  target: FailureReviewTarget,
): { record: AgentCertCorpusRecord; pattern: FailurePattern } | undefined {
  for (const record of records) {
    if (!recordMatchesTarget(record, target)) continue;
    const pattern = record.failurePatterns.find((item) => item.key === target.patternKey);
    if (pattern) return { record, pattern };
  }
  return undefined;
}

function normalizeRecordReviewState(record: AgentCertCorpusRecord): AgentCertCorpusRecord {
  return {
    ...record,
    failurePatterns: record.failurePatterns.map((pattern) => ({
      ...pattern,
      suggestedType: pattern.suggestedType ?? pattern.type,
      reviewStatus: pattern.reviewStatus ?? "unreviewed",
    })),
  };
}

function applyReviewToPattern(record: AgentCertCorpusRecord, pattern: FailurePattern, reviews: FailureReview[]): FailurePattern {
  const suggestedType = pattern.suggestedType ?? pattern.type;
  let next: FailurePattern = {
    ...pattern,
    suggestedType,
    reviewStatus: pattern.reviewStatus ?? "unreviewed",
  };

  for (const review of reviews) {
    if (!reviewApplies(record, pattern, review)) continue;
    next = {
      ...next,
      type: review.type,
      suggestedType,
      reviewStatus: review.status,
      reviewId: review.id,
      reviewedAt: review.reviewedAt,
      reviewer: review.reviewer,
      reviewNote: review.note,
      reviewConfidence: review.confidence,
      reviewEvidenceContext: review.evidenceContext,
      taxonomyRationale: review.taxonomyRationale,
    };
  }

  return next;
}

function reviewApplies(record: AgentCertCorpusRecord, pattern: FailurePattern, review: FailureReview): boolean {
  if (review.target.patternKey !== pattern.key) return false;
  return recordMatchesTarget(record, review.target);
}

function recordMatchesTarget(record: AgentCertCorpusRecord, target: FailureReviewTarget): boolean {
  if (target.recordId && target.recordId !== record.id) return false;
  if (target.runId && target.runId !== record.runId) return false;
  if (target.product && target.product !== record.product) return false;
  if (target.scenarioName && target.scenarioName !== record.scenarioName) return false;
  if (target.faultName && target.faultName !== record.faultName) return false;
  return true;
}

function stableReviewId(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function normalizeReviewConfidence(input: number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isFinite(input) || input < 0 || input > 1) {
    throw new Error("Review confidence must be a number from 0 to 1.");
  }
  return input;
}
