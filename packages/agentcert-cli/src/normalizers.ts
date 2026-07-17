import { createHash } from "node:crypto";
import type { AgentCertEvidence, AgentCertEvidenceStrength, AgentCertResult } from "./types.js";

export function normalizeMcpBenchResult(input: unknown, artifactPath: string): AgentCertResult {
  const value = asRecord(input);
  const violations = Array.isArray(value.violations) ? value.violations : [];
  const scorerResults = Array.isArray(value.scorer_results) ? value.scorer_results : [];
  const runId = stringValue(value.run_id) ?? stableRunId("mcpbench", artifactPath, input);
  const passed = Boolean(value.passed);
  const score = numberValue(value.total_score) ?? 0;

  const evidence: AgentCertEvidence[] = violations.map((violation, index) => {
    const record = asRecord(violation);
    return {
      id: stringValue(record.id) ?? `mcpbench_violation_${index + 1}`,
      kind: stringValue(record.kind) ?? "policy_violation",
      severity: severityValue(record.severity) ?? "high",
      message: stringValue(record.message) ?? "MCPBench policy violation.",
      source: "mcpbench",
      artifactPath,
      metadata: record,
    };
  });

  for (const scorer of scorerResults) {
    const record = asRecord(scorer);
    if (record.passed === false) {
      evidence.push({
        id: `mcpbench_scorer_${evidence.length + 1}`,
        kind: "assertion_result",
        severity: "medium",
        message: `${stringValue(record.name) ?? "scorer"} failed.`,
        source: "mcpbench",
        artifactPath,
        metadata: record,
      });
    }
  }

  return {
    schemaVersion: "1",
    product: "mcpbench",
    runId,
    timestamp: stringValue(value.completed_at) ?? new Date().toISOString(),
    phase: "pre-release",
    score,
    passed,
    certLevel: stringValue(value.cert_level),
    summary: passed ? "MCPBench completed without blocking violations." : "MCPBench found blocking evidence.",
    evidenceStrength: reportedStrength("MCPBench result was imported without a source-signed action journal."),
    artifacts: recordOfStrings(value.artifact_paths, { results: artifactPath }),
    evidence,
  };
}

export function normalizeTripwireResult(input: unknown, artifactPath: string): AgentCertResult {
  const value = asRecord(input);
  const summary = asRecord(value.summary);
  const gate = asRecord(value.gate);
  const runs = Array.isArray(value.runs) ? value.runs : [];
  const overallScore = normalizeScore(numberValue(summary.overallScore) ?? 0);
  const passed = Boolean(gate.passed);
  const evidence: AgentCertEvidence[] = [];

  for (const run of runs) {
    const record = asRecord(run);
    const assertions = Array.isArray(record.assertions) ? record.assertions : [];
    for (const assertion of assertions) {
      const assertionRecord = asRecord(assertion);
      if (assertionRecord.pass === false) {
        evidence.push({
          id: `tripwire_assertion_${evidence.length + 1}`,
          kind: "assertion_result",
          severity: "high",
          message: stringValue(assertionRecord.message) ?? "Tripwire assertion failed.",
          source: "tripwire-ci",
          artifactPath: stringValue(record.tracePath) ?? artifactPath,
          metadata: {
            scenarioName: record.scenarioName,
            faultName: record.faultName,
            assertion: assertionRecord,
          },
        });
      }
    }
  }

  return {
    schemaVersion: "1",
    product: "tripwire-ci",
    runId: stableRunId("tripwire", artifactPath, input),
    timestamp: stringValue(value.timestamp) ?? new Date().toISOString(),
    phase: "pre-release",
    score: overallScore,
    passed,
    summary: passed ? "Tripwire CI gate passed." : "Tripwire CI gate failed.",
    evidenceStrength: reportedStrength("Tripwire result was imported without a source-signed action journal."),
    artifacts: { result: artifactPath, outDir: stringValue(value.outDir) ?? "" },
    evidence,
  };
}

export function normalizeOnegentAuditPacket(input: unknown, artifactPath: string): AgentCertResult {
  const value = asRecord(input);
  const action = asRecord(value.actionIntent);
  const risk = asRecord(value.riskAssessment);
  const approval = asRecord(value.approvalRequest);
  const principal = asRecord(action.principal);
  const authorization = asRecord(value.authorizationDecision);
  const verification = asRecord(value.verificationResult);
  const auditEvents = Array.isArray(value.auditEvents) ? value.auditEvents : [];
  const trusted = asRecord(value.trustedActionEvidence);
  const trustedStrength = evidenceStrengthValue(trusted.evidenceStrength);
  const mandate = asRecord(trusted.mandate);
  const receipt = asRecord(trusted.runReceipt);
  const verificationSuccess = verification.success === true;
  const approved = approval.status === "APPROVED" || approval.status === undefined;
  const passed = verificationSuccess && approved;
  const riskLevel = stringValue(risk.riskLevel) ?? "UNKNOWN";

  const evidence: AgentCertEvidence[] = [
    {
      id: "onegent_principal",
      kind: "runtime_identity",
      severity: "info",
      message: `Runtime action principal: ${stringValue(principal.id) ?? stringValue(action.sourceAgentName) ?? "UNKNOWN"}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: {
        principal,
        requestedPermissions: action.requestedPermissions,
      },
    },
    {
      id: "onegent_risk_assessment",
      kind: "runtime_risk_assessment",
      severity: riskLevel === "CRITICAL" ? "critical" : riskLevel === "HIGH" ? "high" : "medium",
      message: `Runtime action risk assessed as ${riskLevel}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: risk,
    },
  ];

  if (authorization.decision) {
    evidence.push({
      id: "onegent_authorization",
      kind: "authorization_decision",
      severity: authorization.decision === "ALLOW" ? "info" : "critical",
      message: `Runtime authorization decision: ${String(authorization.decision)}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: authorization,
    });
  }

  if (approval.status) {
    evidence.push({
      id: "onegent_approval",
      kind: "approval_record",
      severity: approval.status === "APPROVED" ? "info" : "high",
      message: `Human approval status: ${approval.status}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: approval,
    });
  }

  evidence.push({
    id: "onegent_verification",
    kind: "runtime_verification",
    severity: verificationSuccess ? "info" : "critical",
    message: verificationSuccess
      ? "Observed runtime state matched expected state."
      : "Observed runtime state did not match expected state.",
    source: "onegent-runtime",
    artifactPath,
    metadata: verification,
  });

  if (trustedStrength) {
    evidence.push({
      id: "onegent_action_mandate",
      kind: "action_mandate",
      severity: "info",
      message: `High-risk action was bound to mandate ${stringValue(mandate.mandateId) ?? "UNKNOWN"}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: { mandateId: mandate.mandateId, mandateDigestSha256: mandate.digestSha256 },
    }, {
      id: "onegent_trusted_journal",
      kind: "trusted_action_journal",
      severity: asRecord(receipt.journal).valid === true ? "info" : "critical",
      message: `Source-signed action journal strength: ${trustedStrength.level}.`,
      source: "onegent-runtime",
      artifactPath,
      metadata: { receiptSha256: receipt.receiptSha256, collector: receipt.collector, journal: receipt.journal },
    });
  }

  for (const event of auditEvents) {
    const record = asRecord(event);
    evidence.push({
      id: stringValue(record.id) ?? `onegent_audit_${evidence.length + 1}`,
      kind: "audit_event",
      severity: "info",
      message: stringValue(record.message) ?? stringValue(record.eventType) ?? "Onegent audit event.",
      source: "onegent-runtime",
      artifactPath,
      metadata: record,
    });
  }

  return {
    schemaVersion: "1",
    product: "onegent-runtime",
    runId: stringValue(action.id) ?? stableRunId("onegent", artifactPath, input),
    timestamp: stringValue(verification.createdAt) ?? new Date().toISOString(),
    phase: "runtime",
    score: passed ? 100 : 0,
    passed,
    summary: passed
      ? "Runtime action was approved, mock-executed, verified, and audited."
      : "Runtime action did not complete the approval and verification gate.",
    evidenceStrength: trustedStrength ?? reportedStrength("Onegent audit packet does not include a trusted action receipt."),
    artifacts: { auditPacket: artifactPath },
    evidence,
  };
}

function reportedStrength(limitation: string): AgentCertEvidenceStrength {
  return {
    schemaVersion: "agentcert.evidence_strength.v0.1",
    level: "reported",
    claims: ["A producer supplied a result for this run."],
    limitations: [limitation],
  };
}

function evidenceStrengthValue(input: unknown): AgentCertEvidenceStrength | undefined {
  const value = asRecord(input);
  const level = value.level;
  if (value.schemaVersion !== "agentcert.evidence_strength.v0.1"
    || !["reported", "recorded", "enforced", "outcome_verified", "independently_reviewed"].includes(String(level))) return undefined;
  return {
    schemaVersion: "agentcert.evidence_strength.v0.1",
    level: level as AgentCertEvidenceStrength["level"],
    claims: Array.isArray(value.claims) ? value.claims.filter((item): item is string => typeof item === "string") : [],
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((item): item is string => typeof item === "string") : [],
  };
}

function normalizeScore(value: number): number {
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

function stableRunId(prefix: string, artifactPath: string, input: unknown): string {
  const hash = createHash("sha256").update(`${artifactPath}:${JSON.stringify(input)}`).digest("hex").slice(0, 12);
  return `${prefix}_${hash}`;
}

function recordOfStrings(input: unknown, fallback: Record<string, string>): Record<string, string> {
  const record = asRecord(input);
  const output: Record<string, string> = { ...fallback };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function severityValue(input: unknown): AgentCertEvidence["severity"] | undefined {
  return input === "critical" || input === "high" || input === "medium" || input === "low" || input === "info"
    ? input
    : undefined;
}
