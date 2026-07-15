import type { HostedEvent, HostedFailureReview, HostedIncident } from "./hosted-api";

export const FAILURE_TYPES = [
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
] as const;

export interface EvidenceBundleDocument {
  schemaName: "agentcert.evidence_bundle";
  schemaVersion: string;
  runId: string;
  generatedAt: string;
  subject: { name: string; type: string };
  verdict: { passed: boolean; score: number; level: string };
  summary: { products: string[]; criticalEvidence: number; highEvidence: number; totalEvidence: number };
  results: BundleResult[];
  evidence: BundleEvidence[];
  artifacts: Record<string, string>;
  standards: Array<{ id: string; name: string; status: string; note: string }>;
}

export interface BundleResult {
  product: string;
  runId: string;
  timestamp: string;
  phase: string;
  score: number;
  passed: boolean;
  summary?: string;
  artifacts: Record<string, string>;
  evidence: BundleEvidence[];
}

export interface BundleEvidence {
  id: string;
  kind: string;
  severity: string;
  message: string;
  source?: string;
  artifactPath?: string;
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceFinding extends BundleEvidence {
  patternKey: string;
  suggestedType: string;
  review?: HostedFailureReview;
}

export interface ArtifactPointer {
  label: string;
  path: string;
  kind: "screenshot" | "trace" | "dom" | "report" | "json" | "other";
}

export function parseEvidenceBundle(value: unknown): EvidenceBundleDocument | undefined {
  const input = object(value);
  if (input.schemaName !== "agentcert.evidence_bundle" || typeof input.schemaVersion !== "string") return undefined;
  const subject = object(input.subject);
  const verdict = object(input.verdict);
  const summary = object(input.summary);
  return {
    schemaName: "agentcert.evidence_bundle",
    schemaVersion: input.schemaVersion,
    runId: text(input.runId),
    generatedAt: text(input.generatedAt),
    subject: { name: text(subject.name), type: text(subject.type) },
    verdict: { passed: verdict.passed === true, score: number(verdict.score), level: text(verdict.level) },
    summary: {
      products: strings(summary.products),
      criticalEvidence: number(summary.criticalEvidence),
      highEvidence: number(summary.highEvidence),
      totalEvidence: number(summary.totalEvidence),
    },
    results: array(input.results).map(parseResult),
    evidence: array(input.evidence).map(parseEvidence),
    artifacts: stringRecord(input.artifacts),
    standards: array(input.standards).map((entry) => {
      const standard = object(entry);
      return { id: text(standard.id), name: text(standard.name), status: text(standard.status), note: text(standard.note) };
    }),
  };
}

export function findingsForBundle(bundle: EvidenceBundleDocument | undefined, reviews: HostedFailureReview[]): EvidenceFinding[] {
  if (!bundle) return [];
  const reviewsByPattern = new Map(reviews.map((review) => [review.patternKey, review]));
  return bundle.evidence
    .filter((evidence) => evidence.severity !== "info" && evidence.severity !== "low")
    .map((evidence, index) => {
      const patternKey = evidence.id || `${evidence.kind}:${index}`;
      return {
        ...evidence,
        patternKey,
        suggestedType: taxonomyForEvidence(evidence),
        review: reviewsByPattern.get(patternKey),
      };
    });
}

export function artifactPointers(bundle: EvidenceBundleDocument | undefined): ArtifactPointer[] {
  if (!bundle) return [];
  const values = new Map<string, ArtifactPointer>();
  for (const [label, path] of Object.entries(bundle.artifacts)) addArtifact(values, label, path);
  for (const result of bundle.results) {
    for (const [label, path] of Object.entries(result.artifacts)) addArtifact(values, `${result.product}: ${label}`, path);
  }
  for (const evidence of bundle.evidence) {
    if (evidence.artifactPath) addArtifact(values, evidence.kind, evidence.artifactPath);
  }
  return [...values.values()];
}

export function firstDivergence(
  reviews: HostedFailureReview[],
  incidents: HostedIncident[],
  events: HostedEvent[],
  findings: EvidenceFinding[],
): string | undefined {
  const reviewed = reviews.find((review) => review.evidenceContext.firstDivergenceSnippet)?.evidenceContext.firstDivergenceSnippet;
  if (reviewed) return reviewed;
  const incident = incidents.find((item) => item.firstDivergence)?.firstDivergence;
  if (incident) return incident;
  const event = events.find((item) => /fail|diverg|error|inject/i.test(item.type));
  const eventMessage = event ? messageFromPayload(event.payload) : undefined;
  return eventMessage ?? findings[0]?.message;
}

export function eventMessage(event: HostedEvent): string {
  return messageFromPayload(event.payload) ?? `${event.actor} recorded ${event.type}.`;
}

function parseResult(value: unknown): BundleResult {
  const input = object(value);
  return {
    product: text(input.product), runId: text(input.runId), timestamp: text(input.timestamp), phase: text(input.phase),
    score: number(input.score), passed: input.passed === true, summary: optionalText(input.summary), artifacts: stringRecord(input.artifacts),
    evidence: array(input.evidence).map(parseEvidence),
  };
}

function parseEvidence(value: unknown): BundleEvidence {
  const input = object(value);
  return {
    id: text(input.id), kind: text(input.kind), severity: text(input.severity), message: text(input.message),
    source: optionalText(input.source), artifactPath: optionalText(input.artifactPath), suggestedFix: optionalText(input.suggestedFix),
    metadata: Object.keys(object(input.metadata)).length ? object(input.metadata) : undefined,
  };
}

function taxonomyForEvidence(evidence: BundleEvidence): string {
  const haystack = `${evidence.kind} ${evidence.message}`.toLowerCase();
  if (/prompt.?injection|ignore previous|instruction hijack/.test(haystack)) return "prompt_injection";
  if (/wrong.?click|clicked.*wrong|unexpected control/.test(haystack)) return "wrong_click";
  if (/timeout|timed out|slow.?load/.test(haystack)) return "timeout";
  if (/verification|expected.*observed|outcome mismatch/.test(haystack)) return "verification_gap";
  if (/partial|incomplete success|silent success/.test(haystack)) return "silent_partial_success";
  if (/network|http|request failed|status 5\d\d/.test(haystack)) return "network_failure";
  if (/ui.?drift|button.*rename|dom mutation|selector/.test(haystack)) return "ui_drift";
  if (/policy|approval|permission/.test(haystack)) return "policy_or_approval";
  if (/connect|unreachable|agent process/.test(haystack)) return "agent_connection";
  if (/console/.test(haystack)) return "console_error";
  if (/assert/.test(haystack)) return "assertion_failure";
  return "unknown_failure";
}

function addArtifact(values: Map<string, ArtifactPointer>, label: string, path: string): void {
  if (!path || values.has(path)) return;
  values.set(path, { label, path, kind: artifactKind(path) });
}

function artifactKind(path: string): ArtifactPointer["kind"] {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(lower)) return "screenshot";
  if (/trace|\.zip$/.test(lower)) return "trace";
  if (/dom|\.html?$/.test(lower)) return "dom";
  if (/report|\.pdf$/.test(lower)) return "report";
  if (/\.jsonl?$/.test(lower)) return "json";
  return "other";
}

function messageFromPayload(payload: Record<string, unknown>): string | undefined {
  for (const key of ["message", "summary", "error", "detail", "firstDivergence", "assertion"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value); }
function optionalText(value: unknown): string | undefined { const result = text(value).trim(); return result || undefined; }
function number(value: unknown): number { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function strings(value: unknown): string[] { return array(value).map(text).filter(Boolean); }
function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
