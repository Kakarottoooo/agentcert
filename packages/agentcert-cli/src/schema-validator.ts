import { AGENTCERT_EVIDENCE_SCHEMA_SEMVER, AGENTCERT_EVIDENCE_SCHEMA_VERSION } from "./types.js";
import { validateEvidenceSignature } from "./evidence-signing.js";
import { validateReleaseGateReport } from "./release-gate.js";

export type AgentCertSchemaId =
  | "evidence-bundle"
  | "result"
  | "corpus-record"
  | "failure-review"
  | "classifier-eval"
  | "monitor-snapshot"
  | "robustness-lab"
  | "release-gate"
  | "assurance-report"
  | "assurance-delivery"
  | "evidence-signature"
  | "evidence-strength"
  | "action-mandate"
  | "trusted-action-record"
  | "trusted-run-receipt";

export interface SchemaValidationResult {
  schema: AgentCertSchemaId;
  valid: boolean;
  errors: string[];
}

export function parseSchemaId(input: string | undefined): AgentCertSchemaId {
  const value = input ?? "evidence-bundle";
  if (
    value === "evidence-bundle" ||
    value === "result" ||
    value === "corpus-record" ||
    value === "failure-review" ||
    value === "classifier-eval" ||
    value === "monitor-snapshot" ||
    value === "robustness-lab" ||
    value === "release-gate" ||
    value === "assurance-report" ||
    value === "assurance-delivery" ||
    value === "evidence-signature" ||
    value === "evidence-strength" ||
    value === "action-mandate" ||
    value === "trusted-action-record" ||
    value === "trusted-run-receipt"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported schema "${value}". Use evidence-bundle, result, corpus-record, failure-review, classifier-eval, monitor-snapshot, robustness-lab, release-gate, assurance-report, assurance-delivery, evidence-signature, evidence-strength, action-mandate, trusted-action-record, or trusted-run-receipt.`
  );
}

export function validateAgentCertSchema(schema: AgentCertSchemaId, input: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (schema === "release-gate") {
    errors.push(...validateReleaseGateReport(input));
    return { schema, valid: errors.length === 0, errors };
  }
  if (schema === "evidence-signature") {
    errors.push(...validateEvidenceSignature(input));
    return { schema, valid: errors.length === 0, errors };
  }
  const value = object(input, "$", errors);
  if (value) {
    if (schema === "evidence-bundle") validateEvidenceBundle(value, errors);
    if (schema === "result") validateResult(value, errors);
    if (schema === "corpus-record") validateCorpusRecord(value, errors);
    if (schema === "failure-review") validateFailureReview(value, errors);
    if (schema === "classifier-eval") validateClassifierEval(value, errors);
    if (schema === "monitor-snapshot") validateMonitorSnapshot(value, errors);
    if (schema === "robustness-lab") validateRobustnessLab(value, errors);
    if (schema === "assurance-report") validateAssuranceReport(value, errors);
    if (schema === "assurance-delivery") validateAssuranceDelivery(value, errors);
    if (schema === "evidence-strength") validateEvidenceStrength(value, errors);
    if (schema === "action-mandate") validateActionMandate(value, errors);
    if (schema === "trusted-action-record") validateTrustedActionRecord(value, errors);
    if (schema === "trusted-run-receipt") validateTrustedRunReceipt(value, errors);
  }
  return { schema, valid: errors.length === 0, errors };
}

function validateEvidenceBundle(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaName", "agentcert.evidence_bundle", errors);
  requiredConst(value, "schemaVersion", AGENTCERT_EVIDENCE_SCHEMA_VERSION, errors);
  requiredConst(value, "schemaSemver", AGENTCERT_EVIDENCE_SCHEMA_SEMVER, errors);
  requiredConst(value, "kind", "agentcert.evidence_bundle", errors);
  requiredString(value, "runId", errors);
  requiredString(value, "generatedAt", errors);
  requiredObject(value, "subject", errors);
  requiredObject(value, "verdict", errors);
  requiredObject(value, "summary", errors);
  requiredArray(value, "results", errors);
  requiredArray(value, "evidence", errors);
  requiredObject(value, "artifacts", errors);
  requiredArray(value, "standards", errors);
  if (value.evidenceStrength !== undefined) {
    const strength = recordValue(value.evidenceStrength);
    if (!strength) errors.push("evidenceStrength must be an object.");
    else validateEvidenceStrength(strength, errors, "evidenceStrength.");
  }

  const subject = recordValue(value.subject);
  if (subject) {
    requiredStringAt(subject, "name", "subject.name", errors);
    requiredEnumAt(subject, "type", ["agent", "mcp-server", "tool", "application", "unknown"], "subject.type", errors);
  }
  const verdict = recordValue(value.verdict);
  if (verdict) {
    requiredBooleanAt(verdict, "passed", "verdict.passed", errors);
    requiredNumberRange(verdict, "score", "verdict.score", 0, 100, errors);
    requiredStringAt(verdict, "level", "verdict.level", errors);
  }
  const summary = recordValue(value.summary);
  if (summary) {
    stringArray(summary.products, "summary.products", errors);
    requiredNonNegativeInteger(summary, "criticalEvidence", "summary.criticalEvidence", errors);
    requiredNonNegativeInteger(summary, "highEvidence", "summary.highEvidence", errors);
    requiredNonNegativeInteger(summary, "totalEvidence", "summary.totalEvidence", errors);
  }
  validateTimestamp(value.generatedAt, "generatedAt", errors);
  validateArtifactMap(value.artifacts, "artifacts", errors);
  validateResultArray(value.results, "results", errors);
  validateEvidenceArray(value.evidence, "evidence", errors);
  validateStandards(value.standards, errors);
}

const EVIDENCE_LEVELS = ["reported", "recorded", "enforced", "outcome_verified", "independently_reviewed"];
const ACTION_TYPES = ["SUBMIT", "PAY", "SEND", "UPDATE"];

function validateEvidenceStrength(value: Record<string, unknown>, errors: string[], prefix = ""): void {
  requiredConst(value, "schemaVersion", "agentcert.evidence_strength.v0.1", errors);
  requiredEnumAt(value, "level", EVIDENCE_LEVELS, `${prefix}level`, errors);
  requiredArray(value, "claims", errors);
  requiredArray(value, "limitations", errors);
  stringArray(value.claims, `${prefix}claims`, errors);
  stringArray(value.limitations, `${prefix}limitations`, errors);
}

function validateActionMandate(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "agentcert.action_mandate.v0.1", errors);
  for (const field of ["mandateId", "policySha256", "validFrom", "expiresAt", "issuedAt", "digestSha256"]) requiredString(value, field, errors);
  requiredObject(value, "issuer", errors);
  requiredObject(value, "subject", errors);
  requiredObject(value, "scope", errors);
  requiredObject(value, "sourceSignature", errors);
  sha256Field(value, "policySha256", errors);
  sha256Field(value, "digestSha256", errors);
  for (const field of ["validFrom", "expiresAt", "issuedAt"]) validateTimestamp(value[field], field, errors);
  const scope = recordValue(value.scope);
  if (scope) {
    requiredArray(scope, "actionTypes", errors);
    requiredArray(scope, "targetSystems", errors);
    requiredArray(scope, "permissions", errors);
    if (Array.isArray(scope.actionTypes)) scope.actionTypes.forEach((item, index) => {
      if (!ACTION_TYPES.includes(String(item))) errors.push(`scope.actionTypes[${index}] is not supported.`);
    });
  }
  validateSourceSignature(value.sourceSignature, "sourceSignature", errors);
}

function validateTrustedActionRecord(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "agentcert.trusted_action_record.v0.1", errors);
  for (const field of ["recordId", "runId", "occurredAt", "type", "payloadSha256", "eventHash"]) requiredString(value, field, errors);
  requiredNonNegativeInteger(value, "sequence", "sequence", errors);
  requiredObject(value, "collector", errors);
  requiredObject(value, "payload", errors);
  requiredObject(value, "sourceSignature", errors);
  sha256Field(value, "payloadSha256", errors);
  sha256Field(value, "eventHash", errors);
  if (value.previousEventHash !== undefined) sha256Field(value, "previousEventHash", errors);
  validateTimestamp(value.occurredAt, "occurredAt", errors);
  validateSourceSignature(value.sourceSignature, "sourceSignature", errors);
}

function validateTrustedRunReceipt(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "agentcert.trusted_run_receipt.v0.1", errors);
  for (const field of ["runId", "startedAt", "completedAt", "firstEventHash", "lastEventHash", "sourcePublicKeyPem", "receiptSha256"]) requiredString(value, field, errors);
  for (const field of ["eventCount", "droppedEventCount"]) requiredNonNegativeInteger(value, field, field, errors);
  requiredObject(value, "collector", errors);
  requiredArray(value, "mandateDigests", errors);
  requiredArray(value, "actionIds", errors);
  requiredObject(value, "journal", errors);
  requiredObject(value, "evidenceStrength", errors);
  requiredObject(value, "sourceSignature", errors);
  for (const field of ["firstEventHash", "lastEventHash", "receiptSha256"]) sha256Field(value, field, errors);
  const strength = recordValue(value.evidenceStrength);
  if (strength) validateEvidenceStrength(strength, errors, "evidenceStrength.");
  validateSourceSignature(value.sourceSignature, "sourceSignature", errors);
}

function sha256Field(value: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof value[field] === "string" && !/^[0-9a-f]{64}$/.test(value[field])) errors.push(`${field} must be a lowercase SHA-256 digest.`);
}

function validateSourceSignature(value: unknown, path: string, errors: string[]): void {
  const signature = recordValue(value);
  if (!signature) return;
  if (signature.algorithm !== "Ed25519") errors.push(`${path}.algorithm must equal Ed25519.`);
  requiredStringAt(signature, "keyId", `${path}.keyId`, errors);
  requiredStringAt(signature, "signature", `${path}.signature`, errors);
}

function validateResult(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredString(value, "product", errors);
  requiredString(value, "runId", errors);
  requiredString(value, "timestamp", errors);
  requiredEnum(value, "phase", ["pre-release", "runtime"], errors);
  requiredNumber(value, "score", errors);
  requiredBoolean(value, "passed", errors);
  requiredObject(value, "artifacts", errors);
  requiredArray(value, "evidence", errors);
  requiredNumberRange(value, "score", "score", 0, 100, errors);
  validateTimestamp(value.timestamp, "timestamp", errors);
  validateArtifactMap(value.artifacts, "artifacts", errors);
  validateEvidenceArray(value.evidence, "evidence", errors);
}

function validateResultArray(input: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(input)) return;
  input.forEach((item, index) => {
    const value = object(item, `${path}[${index}]`, errors);
    if (!value) return;
    const nested: string[] = [];
    validateResult(value, nested);
    errors.push(...nested.map((error) => `${path}[${index}].${error}`));
  });
}

function validateEvidenceArray(input: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(input)) return;
  input.forEach((item, index) => {
    const value = object(item, `${path}[${index}]`, errors);
    if (!value) return;
    requiredStringAt(value, "id", `${path}[${index}].id`, errors);
    requiredStringAt(value, "kind", `${path}[${index}].kind`, errors);
    requiredEnumAt(value, "severity", ["critical", "high", "medium", "low", "info"], `${path}[${index}].severity`, errors);
    requiredStringAt(value, "message", `${path}[${index}].message`, errors);
    for (const field of ["source", "artifactPath", "suggestedFix"]) {
      if (value[field] !== undefined && typeof value[field] !== "string") errors.push(`${path}[${index}].${field} must be a string.`);
    }
    if (value.metadata !== undefined && !recordValue(value.metadata)) errors.push(`${path}[${index}].metadata must be an object.`);
  });
}

function validateArtifactMap(input: unknown, path: string, errors: string[]): void {
  const value = recordValue(input);
  if (!value) return;
  for (const [key, item] of Object.entries(value)) if (typeof item !== "string") errors.push(`${path}.${key} must be a string.`);
}

function validateStandards(input: unknown, errors: string[]): void {
  if (!Array.isArray(input)) return;
  input.forEach((item, index) => {
    const value = object(item, `standards[${index}]`, errors);
    if (!value) return;
    requiredStringAt(value, "id", `standards[${index}].id`, errors);
    requiredStringAt(value, "name", `standards[${index}].name`, errors);
    requiredEnumAt(value, "status", ["mapped", "planned"], `standards[${index}].status`, errors);
    requiredStringAt(value, "note", `standards[${index}].note`, errors);
  });
}

function validateCorpusRecord(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredEnum(value, "kind", ["product_run", "scenario_run"], errors);
  requiredString(value, "id", errors);
  requiredString(value, "subject", errors);
  requiredString(value, "agentName", errors);
  requiredString(value, "agentVersion", errors);
  requiredString(value, "runId", errors);
  requiredBoolean(value, "passed", errors);
  requiredArray(value, "failurePatterns", errors);
  if (value.governance !== undefined) {
    const governance = recordValue(value.governance);
    if (!governance) errors.push("governance must be an object.");
    else {
      requiredConst(governance, "schemaVersion", "agentcert.corpus_governance.v0.1", errors);
      requiredEnum(governance, "consent", ["private", "anonymous", "public", "denied"], errors);
      requiredString(governance, "consentSource", errors);
      requiredString(governance, "consentRecordedAt", errors);
      requiredObject(governance, "provenance", errors);
      requiredObject(governance, "redaction", errors);
    }
  }
}

function validateAssuranceReport(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "agentcert.assurance_report.v0.1", errors);
  for (const key of ["assuranceCaseId", "projectId", "policyPackVersion", "evaluationPlanSha256", "reviewerId", "issuedAt", "expiresAt", "statement"]) requiredString(value, key, errors);
  requiredObject(value, "subject", errors);
  requiredArray(value, "evidence", errors);
  requiredConst(value, "decision", "issued", errors);
  requiredArray(value, "limitations", errors);
  if (!/^[0-9a-f]{64}$/.test(String(value.evaluationPlanSha256 ?? ""))) errors.push("evaluationPlanSha256 must be a lowercase SHA-256 digest.");
  validateTimestamp(value.issuedAt, "issuedAt", errors);
  validateTimestamp(value.expiresAt, "expiresAt", errors);
}

function validateAssuranceDelivery(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "agentcert.assurance_delivery.v0.1", errors);
  for (const key of ["engagementId", "projectId", "assuranceCaseId", "dueAt", "deliveredAt", "evaluationPlanSha256", "statement"]) requiredString(value, key, errors);
  for (const key of ["customer", "subject", "sandbox", "workflow", "terms", "decision", "integration", "evidenceStrength", "attestation"]) requiredObject(value, key, errors);
  for (const key of ["baselineEvidence", "remediationItems", "retestEvidence"]) requiredArray(value, key, errors);
  if (!/^[0-9a-f]{64}$/.test(String(value.evaluationPlanSha256 ?? ""))) errors.push("evaluationPlanSha256 must be a lowercase SHA-256 digest.");
  validateTimestamp(value.dueAt, "dueAt", errors);
  validateTimestamp(value.deliveredAt, "deliveredAt", errors);
  const terms = recordValue(value.terms);
  if (terms) {
    if (terms.priceUsd !== 5000) errors.push("terms.priceUsd must equal 5000.");
    if (terms.workflowCount !== 1) errors.push("terms.workflowCount must equal 1.");
    if (terms.includedRetests !== 1) errors.push("terms.includedRetests must equal 1.");
    if (terms.privacy !== "private_by_default") errors.push("terms.privacy must equal private_by_default.");
  }
  const decision = recordValue(value.decision);
  if (decision) requiredEnum(decision, "verdict", ["RELEASE", "RELEASE_WITH_CONTROLS", "BLOCK"], errors);
}

function validateFailureReview(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredConst(value, "kind", "agentcert.failure_review", errors);
  requiredString(value, "id", errors);
  requiredString(value, "reviewedAt", errors);
  requiredString(value, "reviewer", errors);
  requiredEnum(value, "status", ["confirmed", "corrected"], errors);
  requiredObject(value, "target", errors);
  requiredString(value, "type", errors);
}

function validateClassifierEval(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredConst(value, "kind", "agentcert.failure_classifier_evaluation", errors);
  requiredNumber(value, "reviewedRows", errors);
  requiredNumber(value, "correctRows", errors);
  requiredNumber(value, "incorrectRows", errors);
  requiredNumber(value, "precision", errors);
  requiredNumber(value, "coverage", errors);
  requiredArray(value, "byType", errors);
  requiredArray(value, "confusion", errors);
}

function validateMonitorSnapshot(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredConst(value, "kind", "agentcert.monitor_snapshot", errors);
  requiredString(value, "generatedAt", errors);
  requiredString(value, "subject", errors);
  requiredObject(value, "summary", errors);
  requiredObject(value, "filters", errors);
  requiredArray(value, "lifecycle", errors);
  requiredArray(value, "recentRuns", errors);
  requiredArray(value, "failurePatterns", errors);
}

function validateRobustnessLab(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredConst(value, "kind", "agentcert.real_agent_robustness_lab", errors);
  requiredString(value, "generatedAt", errors);
  requiredString(value, "name", errors);
  requiredObject(value, "summary", errors);
  requiredArray(value, "agents", errors);
  requiredArray(value, "faults", errors);
  requiredArray(value, "matrix", errors);
  requiredArray(value, "limitations", errors);
}

function object(input: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  return input as Record<string, unknown>;
}

function requiredConst(input: Record<string, unknown>, key: string, expected: string, errors: string[]): void {
  if (input[key] !== expected) errors.push(`${key} must be ${JSON.stringify(expected)}.`);
}

function requiredString(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "string" || input[key] === "") errors.push(`${key} must be a non-empty string.`);
}

function requiredNumber(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "number" || !Number.isFinite(input[key])) errors.push(`${key} must be a finite number.`);
}

function requiredBoolean(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "boolean") errors.push(`${key} must be a boolean.`);
}

function requiredArray(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (!Array.isArray(input[key])) errors.push(`${key} must be an array.`);
}

function requiredObject(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) errors.push(`${key} must be an object.`);
}

function requiredEnum(input: Record<string, unknown>, key: string, values: string[], errors: string[]): void {
  if (typeof input[key] !== "string" || !values.includes(input[key])) {
    errors.push(`${key} must be one of: ${values.join(", ")}.`);
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function requiredStringAt(input: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  if (typeof input[key] !== "string" || input[key] === "") errors.push(`${path} must be a non-empty string.`);
}

function requiredBooleanAt(input: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  if (typeof input[key] !== "boolean") errors.push(`${path} must be a boolean.`);
}

function requiredEnumAt(input: Record<string, unknown>, key: string, values: string[], path: string, errors: string[]): void {
  if (typeof input[key] !== "string" || !values.includes(input[key] as string)) errors.push(`${path} must be one of: ${values.join(", ")}.`);
}

function requiredNumberRange(input: Record<string, unknown>, key: string, path: string, minimum: number, maximum: number, errors: string[]): void {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${path} must be a finite number from ${minimum} to ${maximum}.`);
  }
}

function requiredNonNegativeInteger(input: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) < 0) errors.push(`${path} must be a non-negative integer.`);
}

function stringArray(input: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) errors.push(`${path} must be an array of strings.`);
}

function validateTimestamp(input: unknown, path: string, errors: string[]): void {
  if (typeof input === "string" && !Number.isFinite(Date.parse(input))) errors.push(`${path} must be a valid date-time string.`);
}
