import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import type { AgentCertRunRecorder } from "./run-recorder.js";

export interface InstrumentedCapability {
  schemaVersion: "agentcert.capability_manifest.v0.1";
  id: string;
  version: string;
  name: string;
  domain: "browser" | "coding" | "data" | "messaging" | "finance" | "custom";
  operations: Array<"read" | "navigate" | "execute" | "create" | "update" | "delete" | "submit" | "send" | "pay" | "export" | "authenticate">;
  sideEffect: "none" | "read" | "write" | "external" | "destructive";
  resourceTypes: string[];
  requiredPermissions: string[];
  risk: "low" | "medium" | "high" | "critical";
  idempotency: "not_applicable" | "optional" | "required" | "unsupported";
  reversibility: "reversible" | "compensatable" | "irreversible" | "unknown";
  enforcement: "observe_only" | "gateway" | "isolated_adapter";
  verification: "none" | "reported" | "independent_probe";
  aliases?: string[];
}

export interface InstrumentedToolOptions<Input, Output> {
  recorder: AgentCertRunRecorder;
  capability: InstrumentedCapability;
  toolName?: string;
  resource?: (input: Input) => { type: string; id?: string } | undefined;
  execute: (input: Input) => Output | Promise<Output>;
}

export function instrumentTool<Input, Output>(options: InstrumentedToolOptions<Input, Output>): (input: Input) => Promise<Output> {
  validateCapability(options.capability);
  const observedName = options.toolName?.trim() || options.capability.id;
  return async (input: Input): Promise<Output> => {
    const invocationId = randomUUID();
    const trace = options.recorder.childTrace();
    const common = {
      schemaVersion: "agentcert.semantic_event.v0.1",
      capabilityId: options.capability.id,
      observedName,
      invocationId,
      resource: options.resource?.(input),
    };
    await options.recorder.recordEvent({
      type: "agentcert.tool.started",
      payload: { semantic: { ...common, phase: "started" }, input: safeDescriptor(input) },
      trace,
    });
    try {
      const output = await options.execute(input);
      await options.recorder.recordEvent({
        type: "agentcert.tool.completed",
        payload: { semantic: { ...common, phase: "completed" }, output: safeDescriptor(output) },
        trace,
      });
      return output;
    } catch (error) {
      await options.recorder.recordEvent({
        type: "agentcert.tool.failed",
        payload: {
          semantic: { ...common, phase: "failed" },
          error: { name: error instanceof Error ? error.name : "Error", message: bounded(error instanceof Error ? error.message : String(error), 500) },
        },
        trace,
      });
      throw error;
    }
  };
}

function safeDescriptor(value: unknown): Record<string, unknown> {
  const normalized = serializable(value);
  const bytes = Buffer.from(canonicalJson(normalized));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    shape: shape(value),
  };
}

function shape(value: unknown): string[] | string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).filter((key) => !sensitiveKey(key)).slice(0, 30);
  return typeof value;
}

function serializable(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(serializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, sensitiveKey(key) ? "[REDACTED]" : serializable(item)]));
  return String(value);
}

function validateCapability(value: InstrumentedCapability): void {
  if (value.schemaVersion !== "agentcert.capability_manifest.v0.1" || !value.id?.trim()) throw new Error("A valid AgentCert capability manifest is required.");
}

function sensitiveKey(key: string): boolean { return /token|secret|password|authorization|cookie|credential|api.?key/i.test(key); }
function bounded(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max)}...`; }
