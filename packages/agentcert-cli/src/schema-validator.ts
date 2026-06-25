export type AgentCertSchemaId =
  | "evidence-bundle"
  | "result"
  | "corpus-record"
  | "failure-review"
  | "classifier-eval"
  | "monitor-snapshot"
  | "robustness-lab";

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
    value === "robustness-lab"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported schema "${value}". Use evidence-bundle, result, corpus-record, failure-review, classifier-eval, monitor-snapshot, or robustness-lab.`
  );
}

export function validateAgentCertSchema(schema: AgentCertSchemaId, input: unknown): SchemaValidationResult {
  const errors: string[] = [];
  const value = object(input, "$", errors);
  if (value) {
    if (schema === "evidence-bundle") validateEvidenceBundle(value, errors);
    if (schema === "result") validateResult(value, errors);
    if (schema === "corpus-record") validateCorpusRecord(value, errors);
    if (schema === "failure-review") validateFailureReview(value, errors);
    if (schema === "classifier-eval") validateClassifierEval(value, errors);
    if (schema === "monitor-snapshot") validateMonitorSnapshot(value, errors);
    if (schema === "robustness-lab") validateRobustnessLab(value, errors);
  }
  return { schema, valid: errors.length === 0, errors };
}

function validateEvidenceBundle(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaName", "agentcert.evidence_bundle", errors);
  requiredConst(value, "schemaVersion", "1", errors);
  requiredConst(value, "schemaSemver", "1.0.0", errors);
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
}

function validateResult(value: Record<string, unknown>, errors: string[]): void {
  requiredConst(value, "schemaVersion", "1", errors);
  requiredEnum(value, "product", ["mcpbench", "tripwire-ci", "onegent-runtime", "agentcert-cli"], errors);
  requiredString(value, "runId", errors);
  requiredString(value, "timestamp", errors);
  requiredEnum(value, "phase", ["pre-release", "runtime"], errors);
  requiredNumber(value, "score", errors);
  requiredBoolean(value, "passed", errors);
  requiredObject(value, "artifacts", errors);
  requiredArray(value, "evidence", errors);
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
