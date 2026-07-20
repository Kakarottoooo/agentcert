import { createHash, randomUUID } from "node:crypto";
import type { ActionRecord, EventRecord, RunRecord } from "./types.js";

export const CAPABILITY_MANIFEST_VERSION = "agentcert.capability_manifest.v0.1" as const;
export const SEMANTIC_EVENT_VERSION = "agentcert.semantic_event.v0.1" as const;
export const SEMANTIC_COVERAGE_VERSION = "agentcert.semantic_coverage.v0.1" as const;

export type CapabilityDomain = "browser" | "coding" | "data" | "messaging" | "finance" | "custom";
export type CapabilityOperation = "read" | "navigate" | "execute" | "create" | "update" | "delete" | "submit" | "send" | "pay" | "export" | "authenticate";
export type CapabilitySideEffect = "none" | "read" | "write" | "external" | "destructive";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type CapabilityEnforcement = "observe_only" | "gateway" | "isolated_adapter";
export type CapabilityVerification = "none" | "reported" | "independent_probe";
export type EvidenceStrength = "reported" | "recorded" | "enforced" | "outcome_verified" | "independently_reviewed";

export interface CapabilityManifest {
  schemaVersion: typeof CAPABILITY_MANIFEST_VERSION;
  id: string;
  version: string;
  name: string;
  description?: string;
  domain: CapabilityDomain;
  operations: CapabilityOperation[];
  sideEffect: CapabilitySideEffect;
  resourceTypes: string[];
  requiredPermissions: string[];
  risk: CapabilityRisk;
  idempotency: "not_applicable" | "optional" | "required" | "unsupported";
  reversibility: "reversible" | "compensatable" | "irreversible" | "unknown";
  enforcement: CapabilityEnforcement;
  verification: CapabilityVerification;
  aliases?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface CapabilityManifestRecord {
  id: string;
  projectId: string;
  manifest: CapabilityManifest;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityCorrectionRecord {
  id: string;
  projectId: string;
  unknownKey: string;
  observedName: string;
  framework?: string;
  eventType: string;
  capabilityId: string;
  rationale: string;
  confidence: number;
  reviewerId: string;
  reviewerEmail?: string;
  source: "human" | "llm_confirmed";
  classifier?: { provider: string; model: string; confidence: number };
  createdAt: string;
  updatedAt: string;
}

export interface SemanticEventDeclaration {
  schemaVersion: typeof SEMANTIC_EVENT_VERSION;
  capabilityId?: string;
  observedName: string;
  phase: "proposed" | "started" | "completed" | "failed" | "observed";
  invocationId?: string;
  resource?: { type: string; id?: string };
  evidenceStrength?: Exclude<EvidenceStrength, "independently_reviewed">;
}

export interface UnknownCapabilityObservation {
  key: string;
  observedName: string;
  framework?: string;
  eventType: string;
  occurrences: number;
  runIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  sample: Record<string, unknown>;
  suggestion?: CapabilitySuggestion;
}

export interface CapabilitySuggestion {
  capabilityId: string;
  confidence: number;
  rationale: string;
  provider: string;
  model: string;
}

export interface CapabilitySuggestionProvider {
  readonly provider: string;
  readonly model: string;
  suggest(input: {
    observedName: string;
    framework?: string;
    eventType: string;
    redactedSample: Record<string, unknown>;
    candidates: Array<Pick<CapabilityManifest, "id" | "name" | "domain" | "operations" | "sideEffect">>;
  }): Promise<Omit<CapabilitySuggestion, "provider" | "model"> | undefined>;
}

export interface SemanticCoverageSnapshot {
  schemaVersion: typeof SEMANTIC_COVERAGE_VERSION;
  projectId: string;
  generatedAt: string;
  periodDays: 7 | 30 | 90;
  since: string;
  totals: {
    candidateEvents: number;
    declaredDroppedEvents: number;
    recognizedEvents: number;
    unknownEvents: number;
    sideEffectingExecutions: number;
    enforcedExecutions: number;
    outcomeVerifiedExecutions: number;
  };
  coverage: {
    observed: CoverageMetric;
    semantic: CoverageMetric;
    enforced: CoverageMetric;
    verified: CoverageMetric;
  };
  evidenceStrength: EvidenceStrength;
  bypassRisk: { status: "none_declared" | "attention" | "critical"; reasons: string[] };
  domains: Array<{ domain: CapabilityDomain; observed: number; recognized: number; enforced: number; verified: number }>;
  unknown: UnknownCapabilityObservation[];
  manifests: { builtin: number; custom: number; corrections: number };
  limitations: string[];
  truncated: { events: boolean; actions: boolean; limitPerEntity: number };
}

export interface CoverageMetric {
  numerator: number;
  denominator: number;
  percent?: number;
  claim: string;
}

interface ResolvedObservation {
  event: EventRecord;
  run?: RunRecord;
  semantic: SemanticEventDeclaration;
  manifest?: CapabilityManifest;
  resolution: "declared" | "human_correction" | "alias" | "unknown";
  unknownKey?: string;
}

const READ_ONLY = { idempotency: "not_applicable", reversibility: "reversible", enforcement: "observe_only", verification: "reported", risk: "low" } as const;
const CONTROLLED_WRITE = { idempotency: "required", reversibility: "compensatable", enforcement: "gateway", verification: "independent_probe", risk: "high" } as const;

export const BUILTIN_CAPABILITY_PACKS: Readonly<Record<Exclude<CapabilityDomain, "custom">, readonly CapabilityManifest[]>> = {
  browser: [
    manifest("browser.navigate", "Browser navigate", "browser", ["navigate", "read"], "read", ["web.page"], ["browser:navigate"], READ_ONLY, ["navigate", "goto", "open_url", "browser.navigate"]),
    manifest("browser.interact", "Browser interaction", "browser", ["execute"], "write", ["web.element"], ["browser:interact"], { ...CONTROLLED_WRITE, risk: "medium", verification: "reported" }, ["click", "type", "select", "browser.click", "browser.interact"]),
    manifest("browser.submit", "Browser form submission", "browser", ["submit"], "external", ["web.form"], ["browser:submit"], CONTROLLED_WRITE, ["submit", "form_submit", "browser.submit"]),
  ],
  coding: [
    manifest("coding.read", "Read source code", "coding", ["read"], "read", ["source.file"], ["repository:read"], READ_ONLY, ["read_file", "cat", "grep", "search_code", "coding.read"]),
    manifest("coding.write", "Modify source code", "coding", ["create", "update", "delete"], "write", ["source.file"], ["repository:write"], { ...CONTROLLED_WRITE, risk: "medium", verification: "reported" }, ["write_file", "apply_patch", "edit_file", "coding.write"]),
    manifest("coding.execute", "Execute code or commands", "coding", ["execute"], "destructive", ["process", "workspace"], ["process:execute"], { ...CONTROLLED_WRITE, reversibility: "unknown", risk: "critical" }, ["shell", "terminal", "exec", "run_command", "coding.execute"]),
  ],
  data: [
    manifest("data.query", "Query structured data", "data", ["read"], "read", ["database", "dataset"], ["data:read"], READ_ONLY, ["query", "select", "sql_query", "data.query"]),
    manifest("data.mutate", "Mutate structured data", "data", ["create", "update", "delete"], "write", ["database", "dataset"], ["data:write"], CONTROLLED_WRITE, ["insert", "update", "delete", "execute_sql", "data.mutate"]),
    manifest("data.export", "Export data", "data", ["export"], "external", ["dataset", "file"], ["data:export"], { ...CONTROLLED_WRITE, reversibility: "irreversible" }, ["export", "download_csv", "data.export"]),
  ],
  messaging: [
    manifest("messaging.read", "Read messages", "messaging", ["read"], "read", ["message", "thread"], ["messages:read"], READ_ONLY, ["read_email", "get_message", "list_messages", "messaging.read"]),
    manifest("messaging.send", "Send an external message", "messaging", ["send"], "external", ["message", "recipient"], ["messages:send"], { ...CONTROLLED_WRITE, reversibility: "irreversible" }, ["send_email", "send_message", "reply", "messaging.send"]),
  ],
  finance: [
    manifest("finance.read", "Read financial records", "finance", ["read"], "read", ["account", "transaction"], ["finance:read"], { ...READ_ONLY, risk: "medium" }, ["get_balance", "list_transactions", "finance.read"]),
    manifest("finance.pay", "Create or submit a payment", "finance", ["pay", "submit"], "external", ["payment", "account"], ["payments:write"], { ...CONTROLLED_WRITE, reversibility: "irreversible", risk: "critical" }, ["pay", "create_payment", "payment_intent", "finance.pay"]),
  ],
};

export const BUILTIN_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.values(BUILTIN_CAPABILITY_PACKS).flat();

export function parseCapabilityManifest(input: unknown): CapabilityManifest {
  const value = object(input, "manifest");
  if (value.schemaVersion !== CAPABILITY_MANIFEST_VERSION) throw new Error(`schemaVersion must be ${CAPABILITY_MANIFEST_VERSION}.`);
  const domain = oneOf(value.domain, "domain", ["browser", "coding", "data", "messaging", "finance", "custom"] as const);
  return {
    schemaVersion: CAPABILITY_MANIFEST_VERSION,
    id: identifier(value.id, "id"),
    version: text(value.version, "version", 100),
    name: text(value.name, "name", 200),
    description: optionalText(value.description, "description", 2000),
    domain,
    operations: stringList(value.operations, "operations", ["read", "navigate", "execute", "create", "update", "delete", "submit", "send", "pay", "export", "authenticate"] as const),
    sideEffect: oneOf(value.sideEffect, "sideEffect", ["none", "read", "write", "external", "destructive"] as const),
    resourceTypes: freeStringList(value.resourceTypes, "resourceTypes", true),
    requiredPermissions: freeStringList(value.requiredPermissions, "requiredPermissions", false),
    risk: oneOf(value.risk, "risk", ["low", "medium", "high", "critical"] as const),
    idempotency: oneOf(value.idempotency, "idempotency", ["not_applicable", "optional", "required", "unsupported"] as const),
    reversibility: oneOf(value.reversibility, "reversibility", ["reversible", "compensatable", "irreversible", "unknown"] as const),
    enforcement: oneOf(value.enforcement, "enforcement", ["observe_only", "gateway", "isolated_adapter"] as const),
    verification: oneOf(value.verification, "verification", ["none", "reported", "independent_probe"] as const),
    aliases: value.aliases === undefined ? undefined : freeStringList(value.aliases, "aliases", false),
    inputSchema: value.inputSchema === undefined ? undefined : object(value.inputSchema, "inputSchema"),
    outputSchema: value.outputSchema === undefined ? undefined : object(value.outputSchema, "outputSchema"),
  };
}

export function buildSemanticCoverage(input: {
  projectId: string;
  runs: RunRecord[];
  events: EventRecord[];
  actions: ActionRecord[];
  customManifests: CapabilityManifestRecord[];
  corrections: CapabilityCorrectionRecord[];
  periodDays: 7 | 30 | 90;
  generatedAt: string;
  since: string;
  independentlyReviewed?: boolean;
  truncated?: { events: boolean; actions: boolean; limitPerEntity: number };
}): SemanticCoverageSnapshot {
  const manifests = [...input.customManifests.map((item) => item.manifest), ...BUILTIN_CAPABILITY_MANIFESTS];
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const corrections = new Map(input.corrections.map((item) => [item.unknownKey, item]));
  const observations = input.events.filter(isCapabilityCandidate).map((event) => resolveObservation(event, runById.get(event.runId), manifests, corrections));
  const executions = collapseObservations(observations);
  const dropped = input.events.reduce((sum, event) => sum + declaredDropCount(event), 0);
  const recognized = observations.filter((item) => item.manifest);
  const sideEffecting = executions.filter((item) => item.manifest && isSideEffecting(item.manifest.sideEffect));
  // Ordinary event producers cannot self-assert enforcement or independent verification.
  // Those claims come only from controlled action records and reconciled trust boundaries.
  const eventEnforced: ResolvedObservation[] = [];
  const eventVerified: ResolvedObservation[] = [];
  const actionEnforced = input.actions.filter((action) => strengthAtLeast(action.assuranceContext?.evidenceStrength, "enforced"));
  const actionVerified = input.actions.filter((action) => action.verificationSuccess === true || strengthAtLeast(action.assuranceContext?.evidenceStrength, "outcome_verified"));
  const sideEffectingExecutions = sideEffecting.length + input.actions.length;
  const enforcedExecutions = eventEnforced.length + actionEnforced.length;
  const outcomeVerifiedExecutions = eventVerified.length + actionVerified.length;
  const unknown = collectUnknown(executions.filter((item) => !item.manifest));
  const reasons: string[] = [];
  if (executions.length + input.actions.length === 0) reasons.push("No capability executions were observed in this window.");
  if (dropped > 0) reasons.push(`${dropped} events were declared dropped.`);
  if (unknown.length > 0) reasons.push(`${unknown.length} capability identities are not semantically classified.`);
  if (sideEffectingExecutions > enforcedExecutions) reasons.push(`${sideEffectingExecutions - enforcedExecutions} side-effecting executions were observed without enforced execution evidence.`);
  if (enforcedExecutions > outcomeVerifiedExecutions) reasons.push(`${enforcedExecutions - outcomeVerifiedExecutions} enforced executions do not have independently verified outcomes.`);
  if (input.truncated?.events || input.truncated?.actions) reasons.push("The analysis window reached a server read bound and is explicitly partial.");
  const domainRows = (["browser", "coding", "data", "messaging", "finance", "custom"] as const).map((domain) => {
    const observed = executions.filter((item) => item.manifest?.domain === domain || (!item.manifest && domain === "custom"));
    const domainActions = input.actions.filter((action) => actionDomain(action) === domain);
    return {
      domain,
      observed: observed.length + domainActions.length,
      recognized: observed.filter((item) => item.manifest).length + domainActions.length,
      enforced: domainActions.filter((action) => strengthAtLeast(action.assuranceContext?.evidenceStrength, "enforced")).length,
      verified: domainActions.filter((action) => action.verificationSuccess === true || strengthAtLeast(action.assuranceContext?.evidenceStrength, "outcome_verified")).length,
    };
  }).filter((item) => item.observed > 0);
  return {
    schemaVersion: SEMANTIC_COVERAGE_VERSION,
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    periodDays: input.periodDays,
    since: input.since,
    totals: {
      candidateEvents: observations.length,
      declaredDroppedEvents: dropped,
      recognizedEvents: recognized.length,
      unknownEvents: observations.length - recognized.length,
      sideEffectingExecutions,
      enforcedExecutions,
      outcomeVerifiedExecutions,
    },
    coverage: {
      observed: metric(observations.length, observations.length + dropped, "Received capability events compared with received plus explicitly declared drops; uninstrumented bypasses remain unknowable."),
      semantic: metric(recognized.length, observations.length, "Received capability events mapped to a declared, built-in, or human-corrected capability."),
      enforced: metric(enforcedExecutions, sideEffectingExecutions, "Observed side effects carrying enforced gateway or isolated-adapter evidence."),
      verified: metric(outcomeVerifiedExecutions, sideEffectingExecutions, "Observed side effects whose expected outcome was independently verified."),
    },
    evidenceStrength: highestEvidenceStrength({
      observedExecutions: executions.length + input.actions.length,
      dropped,
      unknownCapabilities: unknown.length,
      sideEffectingExecutions,
      enforcedExecutions,
      outcomeVerifiedExecutions,
      independentlyReviewed: input.independentlyReviewed,
      truncated: Boolean(input.truncated?.events || input.truncated?.actions),
    }),
    bypassRisk: { status: reasons.some((reason) => reason.includes("side-effecting") || reason.includes("partial")) ? "critical" : reasons.length ? "attention" : "none_declared", reasons },
    domains: domainRows,
    unknown,
    manifests: { builtin: BUILTIN_CAPABILITY_MANIFESTS.length, custom: input.customManifests.length, corrections: input.corrections.length },
    limitations: [
      "Observed coverage cannot prove that an optional recorder saw actions performed through an uninstrumented path.",
      "LLM suggestions are advisory and never raise evidence strength or authorize an action.",
      "Only a credential-isolated gateway and independent outcome probe support enforced and outcome-verified claims.",
    ],
    truncated: input.truncated ?? { events: false, actions: false, limitPerEntity: 10_000 },
  };
}

function collapseObservations(observations: ResolvedObservation[]): ResolvedObservation[] {
  const executions = new Map<string, ResolvedObservation>();
  for (const observation of observations) {
    const invocation = observation.semantic.invocationId;
    const key = invocation
      ? `${observation.event.runId}:${invocation}`
      : `${observation.event.runId}:${observation.event.id}`;
    const current = executions.get(key);
    if (!current || phaseRank(observation.semantic.phase) >= phaseRank(current.semantic.phase)) executions.set(key, observation);
  }
  return [...executions.values()];
}

function phaseRank(phase: SemanticEventDeclaration["phase"]): number {
  if (phase === "failed" || phase === "completed" || phase === "observed") return 2;
  if (phase === "started") return 1;
  return 0;
}

function actionDomain(action: ActionRecord): CapabilityDomain {
  if (action.actionType === "PAY") return "finance";
  if (action.actionType === "SEND") return "messaging";
  if (action.actionType === "UPDATE") return "data";
  return normalize(action.targetSystem).includes("browser") ? "browser" : "custom";
}

export function unknownCapabilityKey(framework: string | undefined, observedName: string, eventType: string): string {
  return createHash("sha256").update(`${normalize(framework ?? "unknown")}|${normalize(observedName)}|${capabilityEventFamily(eventType)}`).digest("hex").slice(0, 24);
}

export function createCapabilityManifestRecord(projectId: string, manifest: CapabilityManifest, createdBy: string, now = new Date().toISOString()): CapabilityManifestRecord {
  return { id: randomUUID(), projectId, manifest, createdBy, createdAt: now, updatedAt: now };
}

function resolveObservation(
  event: EventRecord,
  run: RunRecord | undefined,
  manifests: CapabilityManifest[],
  corrections: Map<string, CapabilityCorrectionRecord>,
): ResolvedObservation {
  const explicit = parseSemanticDeclaration(event);
  const observedName = explicit?.observedName ?? extractObservedName(event);
  const framework = optionalString(run?.metadata.framework);
  const key = unknownCapabilityKey(framework, observedName, event.type);
  const correction = corrections.get(key);
  const declared = explicit?.capabilityId ? manifests.find((item) => item.id === explicit.capabilityId) : undefined;
  const corrected = correction ? manifests.find((item) => item.id === correction.capabilityId) : undefined;
  const alias = manifests.find((item) => aliases(item).has(normalize(observedName)) || aliases(item).has(normalize(event.type)));
  const manifest = declared ?? corrected ?? alias;
  return {
    event,
    run,
    semantic: explicit ?? {
      schemaVersion: SEMANTIC_EVENT_VERSION,
      observedName,
      phase: phaseFromEventType(event.type),
      ...(manifest ? { capabilityId: manifest.id } : {}),
    },
    manifest,
    resolution: declared ? "declared" : corrected ? "human_correction" : alias ? "alias" : "unknown",
    ...(manifest ? {} : { unknownKey: key }),
  };
}

function collectUnknown(observations: ResolvedObservation[]): UnknownCapabilityObservation[] {
  const grouped = new Map<string, UnknownCapabilityObservation>();
  for (const item of observations) {
    const key = item.unknownKey!;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        key,
        observedName: item.semantic.observedName,
        framework: optionalString(item.run?.metadata.framework),
        eventType: item.event.type,
        occurrences: 1,
        runIds: [item.event.runId],
        firstSeenAt: item.event.occurredAt,
        lastSeenAt: item.event.occurredAt,
        sample: boundedSample(item.event.payload),
      });
    } else {
      current.occurrences += 1;
      if (!current.runIds.includes(item.event.runId) && current.runIds.length < 20) current.runIds.push(item.event.runId);
      if (item.event.occurredAt < current.firstSeenAt) current.firstSeenAt = item.event.occurredAt;
      if (item.event.occurredAt > current.lastSeenAt) current.lastSeenAt = item.event.occurredAt;
    }
  }
  return [...grouped.values()].sort((left, right) => right.occurrences - left.occurrences || right.lastSeenAt.localeCompare(left.lastSeenAt));
}

function parseSemanticDeclaration(event: EventRecord): SemanticEventDeclaration | undefined {
  const value = optionalObject(event.payload.semantic);
  if (!value || value.schemaVersion !== SEMANTIC_EVENT_VERSION) return undefined;
  const observedName = optionalString(value.observedName);
  const phase = value.phase;
  if (!observedName || !["proposed", "started", "completed", "failed", "observed"].includes(String(phase))) return undefined;
  const evidenceStrength = optionalString(value.evidenceStrength);
  return {
    schemaVersion: SEMANTIC_EVENT_VERSION,
    observedName,
    phase: phase as SemanticEventDeclaration["phase"],
    capabilityId: optionalString(value.capabilityId),
    invocationId: optionalString(value.invocationId),
    resource: parseResource(value.resource),
    evidenceStrength: isSourceEvidenceStrength(evidenceStrength) ? evidenceStrength : undefined,
  };
}

function isCapabilityCandidate(event: EventRecord): boolean {
  if (optionalObject(event.payload.semantic)?.schemaVersion === SEMANTIC_EVENT_VERSION) return true;
  const type = normalize(event.type);
  return type.includes("tool") || type.includes("browser_use.step") || type.startsWith("mcp.") || type.includes("function") || type.includes("action");
}

function extractObservedName(event: EventRecord): string {
  const payload = event.payload;
  const nestedTool = optionalObject(payload.tool);
  const nestedData = optionalObject(payload.data);
  return optionalString(payload.toolName)
    ?? optionalString(nestedTool?.name)
    ?? optionalString(payload.tool)
    ?? optionalString(payload.name)
    ?? optionalString(nestedData?.name)
    ?? event.type;
}

function phaseFromEventType(type: string): SemanticEventDeclaration["phase"] {
  const normalized = normalize(type);
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (normalized.includes("complete") || normalized.includes("end") || normalized.includes("result")) return "completed";
  if (normalized.includes("propos") || normalized.includes("request")) return "proposed";
  return "started";
}

function highestEvidenceStrength(input: {
  observedExecutions: number;
  dropped: number;
  unknownCapabilities: number;
  sideEffectingExecutions: number;
  enforcedExecutions: number;
  outcomeVerifiedExecutions: number;
  independentlyReviewed?: boolean;
  truncated: boolean;
}): EvidenceStrength {
  if (
    input.independentlyReviewed
    && input.observedExecutions > 0
    && input.dropped === 0
    && input.unknownCapabilities === 0
    && !input.truncated
    && input.sideEffectingExecutions === input.outcomeVerifiedExecutions
  ) return "independently_reviewed";
  if (input.outcomeVerifiedExecutions > 0) return "outcome_verified";
  if (input.enforcedExecutions > 0) return "enforced";
  if (input.observedExecutions > 0) return "recorded";
  return "reported";
}

function declaredDropCount(event: EventRecord): number {
  const normalized = normalize(event.type);
  if (!normalized.includes("dropped")) return 0;
  const value = event.payload.count ?? event.payload.droppedCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function metric(numerator: number, denominator: number, claim: string): CoverageMetric {
  return { numerator, denominator, ...(denominator > 0 ? { percent: Math.round((numerator / denominator) * 10_000) / 100 } : {}), claim };
}

function strengthAtLeast(value: string | undefined, threshold: "recorded" | "enforced" | "outcome_verified"): boolean {
  const ranks = { reported: 0, recorded: 1, enforced: 2, outcome_verified: 3, independently_reviewed: 4 } as const;
  return value !== undefined && value in ranks && ranks[value as keyof typeof ranks] >= ranks[threshold];
}

function isSourceEvidenceStrength(value: string | undefined): value is Exclude<EvidenceStrength, "independently_reviewed"> {
  return value === "reported" || value === "recorded" || value === "enforced" || value === "outcome_verified";
}

function manifest(
  id: string,
  name: string,
  domain: Exclude<CapabilityDomain, "custom">,
  operations: CapabilityOperation[],
  sideEffect: CapabilitySideEffect,
  resourceTypes: string[],
  requiredPermissions: string[],
  controls: Pick<CapabilityManifest, "idempotency" | "reversibility" | "enforcement" | "verification" | "risk">,
  aliases: string[],
): CapabilityManifest {
  return { schemaVersion: CAPABILITY_MANIFEST_VERSION, id, version: "0.1.0", name, domain, operations, sideEffect, resourceTypes, requiredPermissions, ...controls, aliases };
}

function aliases(value: CapabilityManifest): Set<string> {
  return new Set([value.id, value.name, ...(value.aliases ?? [])].map(normalize));
}

function isSideEffecting(value: CapabilitySideEffect): boolean { return value === "write" || value === "external" || value === "destructive"; }
function normalize(value: string): string { return value.trim().toLowerCase().replace(/[\s:/]+/g, "_"); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function object(value: unknown, path: string): Record<string, unknown> { const result = optionalObject(value); if (!result) throw new Error(`${path} must be an object.`); return result; }
function text(value: unknown, path: string, max: number): string { const result = optionalString(value); if (!result || result.length > max) throw new Error(`${path} must be a non-empty string no longer than ${max} characters.`); return result; }
function optionalText(value: unknown, path: string, max: number): string | undefined { return value === undefined ? undefined : text(value, path, max); }
function identifier(value: unknown, path: string): string { const result = text(value, path, 200); if (!/^[a-z0-9][a-z0-9._-]{2,199}$/.test(result)) throw new Error(`${path} is not a valid capability identifier.`); return result; }
function oneOf<const T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number] { if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(", ")}.`); return value as T[number]; }
function stringList<const T extends readonly string[]>(value: unknown, path: string, allowed: T): T[number][] { if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a non-empty array.`); return [...new Set(value.map((item) => oneOf(item, path, allowed)))]; }
function freeStringList(value: unknown, path: string, required: boolean): string[] { if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${path} must be ${required ? "a non-empty" : "an"} array.`); return [...new Set(value.map((item) => text(item, path, 200)))]; }
function parseResource(value: unknown): SemanticEventDeclaration["resource"] { const result = optionalObject(value); const type = optionalString(result?.type); return type ? { type, id: optionalString(result?.id) } : undefined; }
function capabilityEventFamily(value: string): string {
  return normalize(value).replace(/[._-](proposed|started|completed|failed|observed|result|error|end)$/, "");
}

function boundedSample(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redact(value);
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= 2048) return redacted;
  return { truncated: true, keys: Object.keys(value).slice(0, 30) };
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value, 0) as Record<string, unknown>;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => (
    /token|secret|password|authorization|cookie|credential|api[_-]?key/i.test(key)
      ? [key, "[REDACTED]"]
      : [key, redactValue(item, depth + 1)]
  )));
}
