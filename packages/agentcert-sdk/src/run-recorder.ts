import { randomBytes } from "node:crypto";
import type { AgentCertClient, AgentEvent, RunInput, TraceContext } from "./index.js";

export interface RunRecorderOptions {
  batchSize?: number;
  actor?: string;
  nextSequence?: number;
}

export interface RecordEventInput {
  type: string;
  actor?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  trace?: TraceContext;
}

export class AgentCertRunRecorder {
  readonly runId: string;
  readonly trace: TraceContext;
  private readonly pending: AgentEvent[] = [];
  private readonly batchSize: number;
  private readonly actor: string;
  private sequence: number;
  private draining?: Promise<void>;

  private constructor(
    private readonly client: AgentCertClient,
    runId: string,
    trace: TraceContext,
    options: RunRecorderOptions,
  ) {
    this.runId = runId;
    this.trace = trace;
    this.batchSize = integerBetween(options.batchSize ?? 50, 1, 500, "batchSize");
    this.actor = options.actor ?? "agent";
    this.sequence = integerBetween(options.nextSequence ?? 0, 0, Number.MAX_SAFE_INTEGER, "nextSequence");
  }

  static async start(client: AgentCertClient, input: RunInput, options: RunRecorderOptions = {}): Promise<AgentCertRunRecorder> {
    const trace = input.traceId && input.rootSpanId
      ? { traceId: input.traceId, spanId: input.rootSpanId, traceFlags: 1 }
      : newTraceContext();
    const run = await client.startRun({ ...input, traceId: trace.traceId, rootSpanId: trace.spanId });
    const recorder = new AgentCertRunRecorder(client, run.id, trace, options);
    await recorder.recordEvent({
      type: "agentcert.run.started",
      actor: "agentcert-sdk",
      occurredAt: input.startedAt,
      payload: { externalId: input.externalId, kind: input.kind, schemaVersion: input.schemaVersion ?? "agentcert.run.v1" },
      trace,
    });
    return recorder;
  }

  childTrace(parent: TraceContext = this.trace): TraceContext {
    return newTraceContext(parent);
  }

  async recordEvent(input: RecordEventInput): Promise<AgentEvent> {
    const trace = input.trace ?? this.childTrace();
    const event: AgentEvent = {
      sequence: this.sequence,
      type: input.type,
      actor: input.actor ?? this.actor,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload ?? {},
      traceId: trace.traceId,
      spanId: trace.spanId,
      parentSpanId: trace.parentSpanId,
    };
    this.sequence += 1;
    this.pending.push(event);
    if (this.pending.length >= this.batchSize) await this.flush();
    return event;
  }

  async flush(): Promise<void> {
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = undefined; });
    await this.draining;
    if (this.pending.length > 0) await this.flush();
  }

  async complete(input: Parameters<AgentCertClient["completeRun"]>[1]): Promise<Record<string, unknown>> {
    await this.recordEvent({
      type: "agentcert.run.completed",
      actor: "agentcert-sdk",
      payload: { status: input.status, score: input.score },
      trace: this.trace,
    });
    await this.flush();
    return this.client.completeRun(this.runId, input);
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.batchSize);
      try {
        await this.client.appendEvents(this.runId, batch, batchIdempotencyKey(batch));
      } catch (error) {
        this.pending.unshift(...batch);
        throw error;
      }
    }
  }
}

function batchIdempotencyKey(batch: AgentEvent[]): string {
  const first = batch[0]?.sequence;
  const last = batch.at(-1)?.sequence;
  if (first === undefined || last === undefined) throw new Error("Cannot upload an empty event batch.");
  return `events-${first}-${last}`;
}

function newTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? nonZeroHex(16),
    spanId: nonZeroHex(8),
    parentSpanId: parent?.spanId,
    traceFlags: parent?.traceFlags ?? 1,
    traceState: parent?.traceState,
  };
}

function nonZeroHex(bytes: number): string {
  let value = "";
  while (!value || /^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function integerBetween(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
