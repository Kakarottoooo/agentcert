import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

export interface AgentCertClientOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface UniversalEnvelope {
  schemaVersion: "agentcert.envelope.v0.1";
  envelopeId: string;
  kind: "event" | "action";
  occurredAt: string;
  source: { agentId: string; agentVersion?: string; framework?: string; adapter?: string };
  run: { externalId: string; kind?: RunInput["kind"] };
  trace: TraceContext;
  event?: { sequence: number; type: string; actor?: string; attributes?: Record<string, unknown> };
  action?: ActionInput;
}

export interface EvidenceAttestationPayload {
  evidenceId: string;
  projectId: string;
  runId?: string;
  actionId?: string;
  kind: string;
  schemaVersion: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ServerAttestation {
  schemaVersion: "agentcert.server_attestation.v0.1";
  algorithm: "Ed25519";
  keyId: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
}

export interface AgentCertSigningKey {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  status: "active" | "retired" | "revoked";
  activatedAt: string;
  retiredAt?: string;
  revokedAt?: string;
}

export interface RunInput {
  externalId: string;
  agentId?: string;
  kind: "mcpbench" | "tripwire" | "release_gate" | "runtime" | "custom";
  schemaVersion?: string;
  startedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentEvent {
  sequence: number;
  type: string;
  actor?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

export interface ActionInput {
  externalId: string;
  agentId?: string;
  principal: Record<string, unknown>;
  actionType: "SUBMIT" | "PAY" | "SEND" | "UPDATE";
  targetSystem: string;
  requestedPermissions: string[];
  amount?: number;
  currency?: string;
  externalRecipient?: boolean;
  sensitive?: boolean;
  expectedState?: Record<string, unknown>;
}

export interface ActionDecision {
  id: string;
  externalId: string;
  decision: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  status: string;
  riskLevel: string;
  riskScore: number;
  policyVersion: string;
  reasons: string[];
  verificationSuccess?: boolean;
}

export class AgentCertClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly apiKey: string;
  private readonly requestFetch: typeof fetch;

  constructor(options: AgentCertClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.projectId = options.projectId;
    this.apiKey = options.apiKey;
    this.requestFetch = options.fetch ?? fetch;
    if (!this.baseUrl || !this.projectId || !this.apiKey) throw new Error("baseUrl, projectId, and apiKey are required.");
  }

  startRun(input: RunInput): Promise<{ id: string; status: string }> {
    return this.json("runs", { method: "POST", body: JSON.stringify(input) });
  }

  appendEvents(runId: string, events: AgentEvent[]): Promise<{ events: AgentEvent[] }> {
    return this.json(`runs/${encodeURIComponent(runId)}/events`, { method: "POST", body: JSON.stringify({ events }) });
  }

  completeRun(runId: string, input: { status: "passed" | "failed" | "needs_evidence" | "manual_review"; score?: number; summary?: string; firstDivergence?: string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.json(`runs/${encodeURIComponent(runId)}/complete`, { method: "POST", body: JSON.stringify(input) });
  }

  assessAction(input: ActionInput): Promise<ActionDecision> {
    return this.json("actions", { method: "POST", body: JSON.stringify(input) });
  }

  getAction(actionId: string): Promise<ActionDecision> {
    return this.json(`actions/${encodeURIComponent(actionId)}`);
  }

  verifyAction(actionId: string, observedState: Record<string, unknown>): Promise<ActionDecision> {
    return this.json(`actions/${encodeURIComponent(actionId)}/verify`, { method: "POST", body: JSON.stringify({ observedState }) });
  }

  sendEnvelope(input: UniversalEnvelope, idempotencyKey = input.envelopeId): Promise<Record<string, unknown>> {
    return this.json("envelopes", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  async getSigningKey(keyId: string): Promise<AgentCertSigningKey> {
    const response = await this.requestFetch(`${this.baseUrl}/v1/signing-keys/${encodeURIComponent(keyId)}`);
    return await responseJson(response) as unknown as AgentCertSigningKey;
  }

  async verifyEvidenceAttestation(payload: EvidenceAttestationPayload, attestation: ServerAttestation): Promise<boolean> {
    const key = await this.getSigningKey(attestation.keyId);
    if (key.status === "revoked") return false;
    return verifyServerAttestation(payload, attestation, key.publicKeyPem);
  }

  async uploadEvidence(input: { bytes: Uint8Array; fileName: string; contentType?: string; kind?: string; schemaVersion?: string; runId?: string; actionId?: string; sourcePath?: string }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      fileName: input.fileName,
      kind: input.kind ?? "artifact",
      schemaVersion: input.schemaVersion ?? "agentcert.evidence.v0.1",
    });
    if (input.runId) query.set("runId", input.runId);
    if (input.actionId) query.set("actionId", input.actionId);
    if (input.sourcePath) query.set("sourcePath", input.sourcePath);
    const body = new Uint8Array(input.bytes).buffer as ArrayBuffer;
    const response = await this.requestFetch(`${this.projectUrl("evidence")}?${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": input.contentType ?? "application/octet-stream" },
      body,
    });
    return responseJson(response);
  }

  private async json<T>(suffix: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestFetch(this.projectUrl(suffix), {
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    return responseJson(response) as Promise<T>;
  }

  private projectUrl(suffix: string): string {
    return `${this.baseUrl}/v1/projects/${encodeURIComponent(this.projectId)}/${suffix}`;
  }
}

export function createTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? nonZeroHex(16),
    spanId: nonZeroHex(8),
    parentSpanId: parent?.spanId,
    traceFlags: parent?.traceFlags ?? 1,
    traceState: parent?.traceState,
  };
}

export function createEventEnvelope(input: {
  envelopeId?: string;
  occurredAt?: string;
  source: UniversalEnvelope["source"];
  run: UniversalEnvelope["run"];
  trace?: TraceContext;
  event: NonNullable<UniversalEnvelope["event"]>;
}): UniversalEnvelope {
  return {
    schemaVersion: "agentcert.envelope.v0.1",
    envelopeId: input.envelopeId ?? randomUUID(),
    kind: "event",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source,
    run: input.run,
    trace: input.trace ?? createTraceContext(),
    event: input.event,
  };
}

function nonZeroHex(bytes: number): string {
  let value = "";
  while (!value || /^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

export function verifyServerAttestation(payload: EvidenceAttestationPayload, attestation: ServerAttestation, publicKeyPem: string): boolean {
  if (attestation.schemaVersion !== "agentcert.server_attestation.v0.1" || attestation.algorithm !== "Ed25519") return false;
  const bytes = Buffer.from(canonicalJson(payload));
  if (createHash("sha256").update(bytes).digest("hex") !== attestation.payloadSha256) return false;
  try { return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(attestation.signature, "base64url")); }
  catch { return false; }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, canonicalValue(record[key])]));
  }
  throw new Error(`Canonical JSON does not support ${typeof value}.`);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `AgentCert API request failed (${response.status}).`);
  return value;
}
