export interface AgentCertClientOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  fetch?: typeof fetch;
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

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `AgentCert API request failed (${response.status}).`);
  return value;
}
