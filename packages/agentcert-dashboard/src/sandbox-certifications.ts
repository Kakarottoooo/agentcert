import type { EvidenceBundleDocument } from "./evidence-analysis";
import type { HostedRun } from "./hosted-api";

export interface SandboxCertificationCheckView {
  id: string;
  status: "passed" | "failed";
  message: string;
  layer: "adapter" | "safety";
}

export interface SandboxCertificationView {
  implementation: string;
  schemaVersion: string;
  generatedAt: string;
  passed: boolean;
  score: number;
  checks: SandboxCertificationCheckView[];
  disclaimer?: string;
}

export function isSandboxCertificationRun(run: HostedRun): boolean {
  const evidenceType = text(run.metadata.evidenceType);
  return run.metadata.sandboxOnly === true
    || evidenceType === "agentcert.sandbox_adapter_conformance"
    || evidenceType === "agentcert.sandbox_certification"
    || run.schemaVersion.startsWith("agentcert.sandbox_");
}

export function sandboxCertificationFromBundle(bundle?: EvidenceBundleDocument): SandboxCertificationView | undefined {
  if (!bundle) return undefined;
  const evidence = bundle.evidence.find((item) =>
    item.kind === "sandbox_adapter_conformance" || item.kind === "sandbox_certification",
  );
  const report = object(evidence?.metadata?.report);
  if (!text(report.schemaVersion).startsWith("agentcert.sandbox_")) return undefined;
  const verdict = object(report.verdict);
  const checks = parseChecks(report.checks, "adapter");
  const certification = object(report.certification);
  checks.push(...parseChecks(certification.checks, "safety"));
  return {
    implementation: text(report.implementation) || bundle.subject.name,
    schemaVersion: text(report.schemaVersion),
    generatedAt: text(report.generatedAt) || bundle.generatedAt,
    passed: verdict.passed === true,
    score: number(verdict.score),
    checks,
    disclaimer: optionalText(report.disclaimer),
  };
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
