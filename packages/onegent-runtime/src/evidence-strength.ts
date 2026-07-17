import type { EvidenceStrengthAssessment, JournalValidation } from "./trust-types.js";

export interface EvidenceStrengthInput {
  journal: JournalValidation;
  mandateVerified: boolean;
  adapterControlled: boolean;
  outcomeVerified: boolean;
  independentlyReviewed?: boolean;
}
export function assessEvidenceStrength(input: EvidenceStrengthInput): EvidenceStrengthAssessment {
  const claims = ["The integration reported this run and its declared action evidence."];
  const limitations: string[] = [];
  let level: EvidenceStrengthAssessment["level"] = "reported";

  if (input.journal.valid && input.journal.complete && input.journal.sourceSigned && input.journal.droppedEventCount === 0) {
    level = "recorded";
    claims.push("The signed local journal is complete, ordered, hash-linked, and contains no declared dropped events.");
  } else {
    limitations.push(...journalLimitations(input.journal));
  }

  if (level === "recorded" && input.mandateVerified && input.adapterControlled) {
    level = "enforced";
    claims.push("The action matched an active signed mandate and executed through a credential-isolated AgentCert gateway adapter.");
  } else if (level === "recorded") {
    if (!input.mandateVerified) limitations.push("The action was not bound to a verified active mandate.");
    if (!input.adapterControlled) limitations.push("AgentCert did not control a credential-isolated execution boundary.");
  }

  if (level === "enforced" && input.outcomeVerified) {
    level = "outcome_verified";
    claims.push("A separate read path observed the resulting system state and it matched the declared expected outcome.");
  } else if (level === "enforced") {
    limitations.push("No independent outcome observation proved the resulting system state.");
  }

  if (level === "outcome_verified" && input.independentlyReviewed) {
    level = "independently_reviewed";
    claims.push("A reviewer separate from the action principal issued the scoped assurance decision.");
  } else if (level === "outcome_verified") {
    limitations.push("The evidence has not yet received an independent issuance review.");
  }

  return { schemaVersion: "agentcert.evidence_strength.v0.1", level, claims, limitations: [...new Set(limitations)] };
}

function journalLimitations(journal: JournalValidation): string[] {
  const limitations: string[] = [];
  if (!journal.complete) limitations.push("The signed journal does not contain both run start and run completion records.");
  if (!journal.sourceSigned) limitations.push("One or more journal records do not have a valid collector source signature.");
  if (journal.gaps.length) limitations.push(`The journal contains ${journal.gaps.length} sequence gap(s).`);
  if (journal.duplicateSequences.length || journal.duplicateRecordIds.length) limitations.push("The journal contains duplicate sequence numbers or record identifiers.");
  if (journal.hashMismatches.length) limitations.push("The journal hash chain does not reconcile.");
  if (journal.droppedEventCount) limitations.push(`${journal.droppedEventCount} event(s) were declared dropped or recovered from an incomplete tail.`);
  return limitations;
}
