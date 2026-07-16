import { randomBytes, randomUUID } from "node:crypto";
import type { ActionRecord, RunKind } from "./types.js";

export const UNIVERSAL_ENVELOPE_VERSION = "agentcert.envelope.v0.1" as const;

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: string;
}

export interface UniversalEnvelope {
  schemaVersion: typeof UNIVERSAL_ENVELOPE_VERSION;
  envelopeId: string;
  kind: "event" | "action";
  occurredAt: string;
  source: {
    agentId: string;
    agentVersion?: string;
    framework?: string;
    adapter?: string;
  };
  run: {
    externalId: string;
    kind?: RunKind;
  };
  trace: TraceContext;
  event?: {
    sequence: number;
    type: string;
    actor?: string;
    attributes?: Record<string, unknown>;
  };
  action?: {
    externalId: string;
    principal: Record<string, unknown>;
    actionType: ActionRecord["actionType"];
    targetSystem: string;
    requestedPermissions: string[];
    amount?: number;
    currency?: string;
    externalRecipient?: boolean;
    sensitive?: boolean;
    expectedState?: Record<string, unknown>;
  };
}

export class EnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeValidationError";
  }
}

export function parseUniversalEnvelope(input: unknown): UniversalEnvelope {
  const body = object(input, "envelope");
  if (body.schemaVersion !== UNIVERSAL_ENVELOPE_VERSION) {
    throw new EnvelopeValidationError(`schemaVersion must be ${UNIVERSAL_ENVELOPE_VERSION}.`);
  }
  const kind = body.kind;
  if (kind !== "event" && kind !== "action") throw new EnvelopeValidationError("kind must be event or action.");
  const envelopeId = string(body.envelopeId, "envelopeId");
  if (envelopeId.length > 200) throw new EnvelopeValidationError("envelopeId must be at most 200 characters.");
  const occurredAt = isoTimestamp(body.occurredAt, "occurredAt");
  const source = object(body.source, "source");
  const run = object(body.run, "run");
  const trace = parseTraceContext(body.trace);
  const common = {
    schemaVersion: UNIVERSAL_ENVELOPE_VERSION,
    envelopeId,
    kind,
    occurredAt,
    source: {
      agentId: string(source.agentId, "source.agentId"),
      agentVersion: optionalString(source.agentVersion, "source.agentVersion"),
      framework: optionalString(source.framework, "source.framework"),
      adapter: optionalString(source.adapter, "source.adapter"),
    },
    run: {
      externalId: string(run.externalId, "run.externalId"),
      kind: optionalRunKind(run.kind),
    },
    trace,
  };
  if (kind === "event") {
    if (body.action !== undefined) throw new EnvelopeValidationError("event envelopes cannot contain action.");
    const event = object(body.event, "event");
    return {
      ...common,
      kind,
      event: {
        sequence: nonNegativeInteger(event.sequence, "event.sequence"),
        type: string(event.type, "event.type"),
        actor: optionalString(event.actor, "event.actor"),
        attributes: event.attributes === undefined ? undefined : object(event.attributes, "event.attributes"),
      },
    };
  }
  if (body.event !== undefined) throw new EnvelopeValidationError("action envelopes cannot contain event.");
  const action = object(body.action, "action");
  return {
    ...common,
    kind,
    action: {
      externalId: string(action.externalId, "action.externalId"),
      principal: object(action.principal, "action.principal"),
      actionType: actionType(action.actionType),
      targetSystem: string(action.targetSystem, "action.targetSystem"),
      requestedPermissions: stringArray(action.requestedPermissions, "action.requestedPermissions"),
      amount: optionalNumber(action.amount, "action.amount"),
      currency: optionalString(action.currency, "action.currency"),
      externalRecipient: optionalBoolean(action.externalRecipient, "action.externalRecipient"),
      sensitive: optionalBoolean(action.sensitive, "action.sensitive"),
      expectedState: action.expectedState === undefined ? undefined : object(action.expectedState, "action.expectedState"),
    },
  };
}

export function parseTraceContext(input: unknown): TraceContext {
  const trace = object(input, "trace");
  const traceId = string(trace.traceId, "trace.traceId").toLowerCase();
  const spanId = string(trace.spanId, "trace.spanId").toLowerCase();
  const parentSpanId = optionalString(trace.parentSpanId, "trace.parentSpanId")?.toLowerCase();
  if (!isTraceId(traceId)) throw new EnvelopeValidationError("trace.traceId must be 32 lowercase hex characters and cannot be all zeroes.");
  if (!isSpanId(spanId)) throw new EnvelopeValidationError("trace.spanId must be 16 lowercase hex characters and cannot be all zeroes.");
  if (parentSpanId && !isSpanId(parentSpanId)) throw new EnvelopeValidationError("trace.parentSpanId must be 16 lowercase hex characters and cannot be all zeroes.");
  const traceFlags = trace.traceFlags === undefined ? undefined : nonNegativeInteger(trace.traceFlags, "trace.traceFlags");
  if (traceFlags !== undefined && traceFlags > 255) throw new EnvelopeValidationError("trace.traceFlags must be between 0 and 255.");
  return { traceId, spanId, parentSpanId, traceFlags, traceState: optionalString(trace.traceState, "trace.traceState") };
}

export function createTraceContext(parent?: Pick<TraceContext, "traceId" | "spanId" | "traceFlags" | "traceState">): TraceContext {
  return {
    traceId: parent?.traceId ?? nonZeroHex(16),
    spanId: nonZeroHex(8),
    parentSpanId: parent?.spanId,
    traceFlags: parent?.traceFlags ?? 1,
    traceState: parent?.traceState,
  };
}

export function createEnvelopeId(): string {
  return randomUUID();
}

export function isTraceId(value: string): boolean { return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value); }
export function isSpanId(value: string): boolean { return /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value); }

function nonZeroHex(bytes: number): string {
  let value = "";
  while (!value || /^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EnvelopeValidationError(`${path} must be an object.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new EnvelopeValidationError(`${path} must be a non-empty string.`);
  return value.trim();
}
function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}
function isoTimestamp(value: unknown, path: string): string {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new EnvelopeValidationError(`${path} must be an ISO-8601 timestamp.`);
  return new Date(result).toISOString();
}
function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new EnvelopeValidationError(`${path} must be a non-negative integer.`);
  return Number(value);
}
function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new EnvelopeValidationError(`${path} must be a finite number.`);
  return value;
}
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new EnvelopeValidationError(`${path} must be a boolean.`);
  return value;
}
function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new EnvelopeValidationError(`${path} must be an array of non-empty strings.`);
  }
  return value.map((item) => String(item).trim());
}
function optionalRunKind(value: unknown): RunKind | undefined {
  if (value === undefined) return undefined;
  if (value === "mcpbench" || value === "tripwire" || value === "release_gate" || value === "runtime" || value === "custom") return value;
  throw new EnvelopeValidationError("run.kind must be mcpbench, tripwire, release_gate, runtime, or custom.");
}
function actionType(value: unknown): ActionRecord["actionType"] {
  if (value === "SUBMIT" || value === "PAY" || value === "SEND" || value === "UPDATE") return value;
  throw new EnvelopeValidationError("action.actionType must be SUBMIT, PAY, SEND, or UPDATE.");
}
