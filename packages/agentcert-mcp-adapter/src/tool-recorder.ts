import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentCertClient } from "agentcert-sdk";

export interface McpCapabilityManifest {
  schemaVersion: "agentcert.capability_manifest.v0.1";
  id: string;
}

export interface McpToolRecorderOptions {
  runId: string;
  nextSequence?: number;
  traceId?: string;
  rootSpanId?: string;
}

export class AgentCertMcpToolRecorder {
  private sequence: number;
  private readonly traceId: string;
  private readonly rootSpanId: string;

  constructor(private readonly client: AgentCertClient, private readonly options: McpToolRecorderOptions) {
    this.sequence = options.nextSequence ?? 0;
    this.traceId = options.traceId ?? randomBytes(16).toString("hex");
    this.rootSpanId = options.rootSpanId ?? randomBytes(8).toString("hex");
  }

  async call<Input extends Record<string, unknown>, Output>(input: {
    serverName: string;
    toolName: string;
    arguments: Input;
    capability?: McpCapabilityManifest;
    invoke: () => Promise<Output>;
  }): Promise<Output> {
    const invocationId = randomUUID();
    const spanId = randomBytes(8).toString("hex");
    const common = {
      schemaVersion: "agentcert.semantic_event.v0.1",
      observedName: `${input.serverName}.${input.toolName}`,
      ...(input.capability ? { capabilityId: input.capability.id } : {}),
      invocationId,
      resource: { type: "mcp.tool", id: `${input.serverName}/${input.toolName}` },
    };
    await this.record("agentcert.mcp.tool.started", { semantic: { ...common, phase: "started" }, input: descriptor(input.arguments) }, spanId);
    try {
      const output = await input.invoke();
      await this.record("agentcert.mcp.tool.completed", { semantic: { ...common, phase: "completed" }, output: descriptor(output) }, spanId);
      return output;
    } catch (error) {
      await this.record("agentcert.mcp.tool.failed", {
        semantic: { ...common, phase: "failed" },
        error: { name: error instanceof Error ? error.name : "Error", message: String(error instanceof Error ? error.message : error).slice(0, 500) },
      }, spanId);
      throw error;
    }
  }

  private async record(type: string, payload: Record<string, unknown>, spanId: string): Promise<void> {
    const sequence = this.sequence;
    this.sequence += 1;
    await this.client.appendEvents(this.options.runId, [{
      sequence, type, actor: "mcp-adapter", payload,
      traceId: this.traceId, spanId, parentSpanId: this.rootSpanId,
    }], `mcp-semantic-${sequence}`);
  }
}

function descriptor(value: unknown): Record<string, unknown> {
  const safe = sanitize(value);
  const bytes = Buffer.from(JSON.stringify(safe));
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, shape: shape(value) };
}

function sanitize(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, /token|secret|password|authorization|cookie|credential|api.?key/i.test(key) ? "[REDACTED]" : sanitize(item)]));
  return String(value);
}

function shape(value: unknown): string[] | string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).filter((key) => !/token|secret|password|authorization|cookie|credential|api.?key/i.test(key)).slice(0, 30);
  return typeof value;
}
