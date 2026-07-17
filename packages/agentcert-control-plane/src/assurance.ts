import { createHash } from "node:crypto";
import { canonicalJson, type EvidenceSigner } from "./signing.js";
import type {
  AssuranceCaseRecord,
  AssuranceCaseStatus,
  AssuranceDeliveryPacket,
  AssuranceDeliveryPacketPayload,
  AssuranceReport,
  AssuranceReportPayload,
  EvidenceRecord,
} from "./types.js";

const TRANSITIONS: Record<AssuranceCaseStatus, AssuranceCaseStatus[]> = {
  draft: ["evaluating", "revoked"],
  evaluating: ["review_required", "revoked"],
  review_required: ["evaluating", "issued", "revoked"],
  issued: ["suspended", "revoked", "expired"],
  suspended: ["evaluating", "revoked"],
  revoked: [],
  expired: ["evaluating", "revoked"],
};

export function evaluationPlanDigest(plan: AssuranceCaseRecord["evaluationPlan"]): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

export function canTransitionAssuranceCase(from: AssuranceCaseStatus, to: AssuranceCaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function missingRequiredEvidence(caseRecord: AssuranceCaseRecord, evidence: EvidenceRecord[]): string[] {
  const kinds = new Set(evidence.map((item) => item.kind));
  return caseRecord.evaluationPlan.requiredEvidenceKinds.filter((kind) => !kinds.has(kind));
}

export function buildAssuranceReport(
  caseRecord: AssuranceCaseRecord,
  evidence: EvidenceRecord[],
  reviewerId: string,
  issuedAt: string,
  expiresAt: string,
  signer?: EvidenceSigner,
): AssuranceReport {
  const evidenceStrength = assuranceEvidenceStrength(caseRecord, evidence, reviewerId);
  const payload: AssuranceReportPayload = {
    schemaVersion: "agentcert.assurance_report.v0.1",
    assuranceCaseId: caseRecord.id,
    projectId: caseRecord.projectId,
    subject: caseRecord.subject,
    policyPackVersion: caseRecord.policyPackVersion,
    evaluationPlanSha256: caseRecord.evaluationPlanSha256,
    evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, schemaVersion: item.schemaVersion, sha256: item.sha256, sizeBytes: item.sizeBytes })),
    decision: "issued",
    reviewerId,
    issuedAt,
    expiresAt,
    limitations: caseRecord.evaluationPlan.limitations,
    statement: "This report records the scoped evidence and review decision. It is not a regulatory certification or a guarantee of future agent behavior.",
    evidenceStrength,
  };
  return { ...payload, ...(signer ? { attestation: signer.attestCanonical(payload, issuedAt) } : {}) };
}

export function buildAssuranceDeliveryPacket(
  caseRecord: AssuranceCaseRecord,
  evidence: EvidenceRecord[],
  reviewerId: string,
  deliveredAt: string,
  signer: EvidenceSigner,
): AssuranceDeliveryPacket {
  const engagement = caseRecord.engagement;
  if (!engagement?.baseline || !engagement.retest || !engagement.decision || !engagement.firstEvidenceAt
    || engagement.timeToFirstEvidenceSeconds === undefined) {
    throw new Error("Assurance engagement is incomplete and cannot be delivered.");
  }
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const references = (ids: string[]) => ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`Delivery evidence ${id} was not provided.`);
    return { id: item.id, kind: item.kind, schemaVersion: item.schemaVersion, sha256: item.sha256, sizeBytes: item.sizeBytes };
  });
  const payload: AssuranceDeliveryPacketPayload = {
    schemaVersion: "agentcert.assurance_delivery.v0.1",
    engagementId: caseRecord.id,
    projectId: caseRecord.projectId,
    assuranceCaseId: caseRecord.id,
    customer: { name: engagement.customer.name },
    subject: caseRecord.subject,
    sandbox: engagement.sandbox,
    workflow: engagement.workflow,
    terms: engagement.terms,
    dueAt: engagement.dueAt,
    deliveredAt,
    evaluationPlanSha256: caseRecord.evaluationPlanSha256,
    baselineEvidence: references(engagement.baseline.evidenceIds),
    remediationItems: engagement.remediationItems,
    retestEvidence: references(engagement.retest.evidenceIds),
    decision: engagement.decision,
    integration: {
      startedAt: engagement.integrationStartedAt,
      firstEvidenceAt: engagement.firstEvidenceAt,
      timeToFirstEvidenceSeconds: engagement.timeToFirstEvidenceSeconds,
    },
    evidenceStrength: assuranceEvidenceStrength(caseRecord, evidence, reviewerId),
    statement: "This fixed-scope review covers one declared agent version, one sandbox workflow, and one retest. It is not a guarantee of future behavior or regulatory certification.",
  };
  return { ...payload, attestation: signer.attestCanonical(payload, deliveredAt) };
}

type UnderlyingStrength = AssuranceReportPayload["evidenceStrength"]["underlyingLevel"];
const STRENGTH_ORDER: UnderlyingStrength[] = ["reported", "recorded", "enforced", "outcome_verified"];

function assuranceEvidenceStrength(
  caseRecord: AssuranceCaseRecord,
  evidence: EvidenceRecord[],
  reviewerId: string,
): AssuranceReportPayload["evidenceStrength"] {
  const declared = evidence.map(extractEvidenceStrength).filter((value): value is UnderlyingStrength => Boolean(value));
  const underlyingLevel = declared.length === evidence.length && declared.length > 0
    ? declared.reduce((weakest, value) => STRENGTH_ORDER.indexOf(value) < STRENGTH_ORDER.indexOf(weakest) ? value : weakest, "outcome_verified")
    : "reported";
  const independentlyReviewed = reviewerId !== caseRecord.createdBy && underlyingLevel === "outcome_verified";
  return {
    schemaVersion: "agentcert.evidence_strength.v0.1",
    level: independentlyReviewed ? "independently_reviewed" : underlyingLevel,
    underlyingLevel,
    claims: [
      `The assurance case reviewed ${evidence.length} immutable evidence object${evidence.length === 1 ? "" : "s"}.`,
      ...(independentlyReviewed ? ["An identified reviewer separate from the case creator issued this scoped decision."] : []),
    ],
    limitations: [
      ...caseRecord.evaluationPlan.limitations,
      ...(declared.length !== evidence.length ? ["One or more evidence objects did not declare a source evidence-strength level."] : []),
      ...(!independentlyReviewed ? ["This report does not meet the independently-reviewed evidence-strength threshold."] : []),
    ],
  };
}

function extractEvidenceStrength(evidence: EvidenceRecord): UnderlyingStrength | undefined {
  const metadata = evidence.metadata as Record<string, unknown>;
  const direct = record(metadata.evidenceStrength);
  const bundle = record(metadata.bundle);
  const nested = record(bundle.evidenceStrength);
  const level = direct.level ?? nested.level;
  return STRENGTH_ORDER.includes(level as UnderlyingStrength) ? level as UnderlyingStrength : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
