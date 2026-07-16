import type { EvidenceBundleDocument } from "./evidence-analysis";
import type { HostedRun } from "./hosted-api";

export interface SandboxCertificationCheckView {
  id: string;
  status: "passed" | "failed";
  message: string;
  layer: "adapter" | "safety" | "egress";
}

export interface SandboxEgressPolicyView {
  vendor?: string;
  environment?: string;
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedResources: string[];
  timeoutMs?: number;
  maxRequestsPerMinute?: number;
}

export interface SandboxEgressAuditView {
  requestId: string;
  resource: string;
  method: string;
  outcome: string;
  status?: number;
  durationMs: number;
}

export interface SandboxCertificationView {
  implementation: string;
  schemaVersion: string;
  generatedAt: string;
  passed: boolean;
  score: number;
  checks: SandboxCertificationCheckView[];
  egressPolicy?: SandboxEgressPolicyView;
  requestAudit: SandboxEgressAuditView[];
  disclaimer?: string;
}

export interface VendorAcceptanceHistoryView {
  totalRuns: number;
  passingRuns: number;
  passRate: number;
  trend: "waiting" | "baseline" | "stable" | "recovered" | "regressed";
  regressions: string[];
  latest?: HostedRun;
  previous?: HostedRun;
}

const VENDOR_ACCEPTANCE_PREFIX = "vendor-acceptance:stripe:";

export function isSandboxCertificationRun(run: HostedRun): boolean {
  const evidenceType = text(run.metadata.evidenceType);
  return run.metadata.sandboxOnly === true
    || evidenceType === "agentcert.sandbox_adapter_conformance"
    || evidenceType === "agentcert.sandbox_certification"
    || evidenceType === "agentcert.sandbox_vendor_egress"
    || run.schemaVersion.startsWith("agentcert.sandbox_");
}

export function vendorAcceptanceHistory(runs: HostedRun[]): VendorAcceptanceHistoryView {
  const accepted = runs
    .filter((run) => run.externalId.startsWith(VENDOR_ACCEPTANCE_PREFIX))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const latest = accepted[0];
  const previous = accepted[1];
  const passingRuns = accepted.filter((run) => run.status === "passed").length;
  const regressions: string[] = [];
  if (latest && latest.status !== "passed") regressions.push("latest run failed");
  if (latest && previous) {
    if (normalizedScore(latest.score) < normalizedScore(previous.score)) regressions.push("score decreased");
    if (latest.schemaVersion !== previous.schemaVersion) regressions.push("schema changed");
    const latestPolicy = text(latest.metadata.policySha256);
    const previousPolicy = text(previous.metadata.policySha256);
    if (latestPolicy && previousPolicy && latestPolicy !== previousPolicy) regressions.push("egress policy changed");
  }
  const trend = !latest
    ? "waiting"
    : regressions.length > 0
      ? "regressed"
      : !previous
        ? "baseline"
        : previous.status !== "passed"
          ? "recovered"
          : "stable";
  return {
    totalRuns: accepted.length,
    passingRuns,
    passRate: accepted.length ? passingRuns / accepted.length : 0,
    trend,
    regressions,
    latest,
    previous,
  };
}

export function sandboxCertificationFromBundle(bundle?: EvidenceBundleDocument): SandboxCertificationView | undefined {
  if (!bundle) return undefined;
  const evidence = bundle.evidence.find((item) =>
    item.kind === "sandbox_adapter_conformance"
      || item.kind === "sandbox_certification"
      || item.kind === "sandbox_vendor_egress",
  );
  const report = object(evidence?.metadata?.report);
  if (!text(report.schemaVersion).startsWith("agentcert.sandbox_")) return undefined;
  const verdict = object(report.verdict);
  const vendorEgress = text(report.kind) === "agentcert.sandbox_vendor_egress";
  const checks = parseChecks(report.checks, vendorEgress ? "egress" : "adapter");
  const certification = object(report.certification);
  checks.push(...parseChecks(certification.checks, "safety"));
  return {
    implementation: text(report.implementation) || bundle.subject.name,
    schemaVersion: text(report.schemaVersion),
    generatedAt: text(report.generatedAt) || bundle.generatedAt,
    passed: verdict.passed === true,
    score: number(verdict.score),
    checks,
    egressPolicy: vendorEgress ? parseEgressPolicy(report) : undefined,
    requestAudit: vendorEgress ? parseRequestAudit(report.audit) : [],
    disclaimer: optionalText(report.disclaimer),
  };
}

function parseEgressPolicy(report: Record<string, unknown>): SandboxEgressPolicyView {
  const policy = object(report.policy);
  return {
    vendor: optionalText(report.vendor),
    environment: optionalText(report.environment),
    allowedOrigins: stringArray(policy.allowedOrigins),
    allowedMethods: stringArray(policy.allowedMethods),
    allowedResources: stringArray(policy.allowedResources),
    timeoutMs: optionalNumber(policy.timeoutMs),
    maxRequestsPerMinute: optionalNumber(policy.maxRequestsPerMinute),
  };
}

function parseRequestAudit(value: unknown): SandboxEgressAuditView[] {
  return array(value).map((entry) => {
    const audit = object(entry);
    return {
      requestId: text(audit.requestId),
      resource: text(audit.resource),
      method: text(audit.method),
      outcome: text(audit.outcome),
      status: optionalNumber(audit.status),
      durationMs: number(audit.durationMs),
    };
  }).filter((entry) => entry.requestId && entry.resource && entry.outcome);
}

function parseChecks(value: unknown, layer: SandboxCertificationCheckView["layer"]): SandboxCertificationCheckView[] {
  return array(value).map((entry) => {
    const check = object(entry);
    return {
      id: text(check.id),
      status: check.status === "passed" ? "passed" as const : "failed" as const,
      message: text(check.message),
      layer,
    };
  }).filter((check) => check.id && check.message);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalText(value: unknown): string | undefined { return text(value).trim() || undefined; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function normalizedScore(value?: number): number { return value === undefined ? 0 : value <= 1 ? value * 100 : value; }
function optionalNumber(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function stringArray(value: unknown): string[] { return array(value).map(text).filter(Boolean); }
