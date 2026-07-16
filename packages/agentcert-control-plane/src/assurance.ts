import { createHash } from "node:crypto";
import { canonicalJson, type EvidenceSigner } from "./signing.js";
import type {
  AssuranceCaseRecord,
  AssuranceCaseStatus,
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
  };
  return { ...payload, ...(signer ? { attestation: signer.attestCanonical(payload, issuedAt) } : {}) };
}
