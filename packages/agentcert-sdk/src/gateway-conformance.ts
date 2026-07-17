import { randomUUID } from "node:crypto";
import type { RemoteTrustedSourceRecord } from "./remote-collector.js";

export interface CollectorGatewayConformanceOptions {
  baseUrl: string;
  gatewayToken: string;
  fetch?: typeof fetch;
}

export interface CollectorGatewayConformanceReport {
  schemaVersion: "agentcert.collector_gateway_conformance.v0.2";
  runId: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; message: string }>;
  completedAt: string;
}

export async function runCollectorGatewayConformance(options: CollectorGatewayConformanceOptions): Promise<CollectorGatewayConformanceReport> {
  const request = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const runId = `conformance-${randomUUID()}`;
  const checks: CollectorGatewayConformanceReport["checks"] = [];
  const unauthorized = await request(`${baseUrl}/v1/flush`, { method: "POST" });
  check(checks, "local-auth", unauthorized.status === 401, `Expected 401 without a gateway token; received ${unauthorized.status}.`);

  const started = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/start`, { payload: { suite: "agentcert.collector_gateway_conformance.v0.2" } });
  const startedRecord = record(started.body);
  check(checks, "durable-start", started.status === 202 && started.body.durable === true && startedRecord.sequence === 0 && startedRecord.type === "RUN_STARTED", "RUN_STARTED must be durably accepted at sequence 0.");
  check(checks, "source-signature", startedRecord.sourceSignature.algorithm === "Ed25519" && Boolean(startedRecord.sourceSignature.signature), "RUN_STARTED must carry an Ed25519 source signature.");

  const input = { type: "CONFORMANCE_EVENT", payload: { value: 1 }, idempotencyKey: "stable-event" };
  const first = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/events`, input);
  const replay = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/events`, input);
  const firstRecord = record(first.body);
  const replayRecord = record(replay.body);
  check(checks, "strict-chain", firstRecord.sequence === 1 && firstRecord.previousEventHash === startedRecord.eventHash, "The first event must follow sequence 0 and reference its event hash.");
  check(checks, "idempotent-replay", firstRecord.recordId === replayRecord.recordId && firstRecord.eventHash === replayRecord.eventHash, "Replaying an idempotency key must return the original record.");

  const conflict = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/events`, { ...input, payload: { value: 2 } });
  check(checks, "replay-conflict", conflict.status === 409, `Reusing an idempotency key with different content must return 409; received ${conflict.status}.`);

  const dropped = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/drops`, { count: 2, reason: "conformance-declared-drop", idempotencyKey: "drop-1" });
  const droppedRecord = record(dropped.body);
  check(checks, "declared-drop", droppedRecord.type === "EVENTS_DROPPED" && droppedRecord.sequence === 4 && droppedRecord.payload.count === 2, "Two dropped events must create an explicit two-sequence gap and EVENTS_DROPPED record.");

  const completed = await post(request, baseUrl, options.gatewayToken, `/v1/runs/${runId}/complete`, {
    payload: { verdict: "conformance" },
    evidenceStrength: { schemaVersion: "agentcert.evidence_strength.v0.1", level: "recorded", claims: [], limitations: [] },
  });
  const completedRecord = record(completed.body);
  check(checks, "signed-completion", completed.status === 202 && completedRecord.type === "RUN_COMPLETED" && completedRecord.sequence === 5, "RUN_COMPLETED must close the signed sequence after declared drops.");
  check(checks, "remote-reconciliation", Number((completed.body.remote as Record<string, unknown>)?.pending) === 0, "A connected conformance run must finish with no pending remote records.");

  return {
    schemaVersion: "agentcert.collector_gateway_conformance.v0.2",
    runId,
    passed: checks.every((item) => item.passed),
    checks,
    completedAt: new Date().toISOString(),
  };
}

async function post(request: typeof fetch, baseUrl: string, token: string, path: string, body: Record<string, unknown>) {
  const response = await request(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

function record(body: Record<string, unknown>): RemoteTrustedSourceRecord {
  if (!body.record || typeof body.record !== "object") return {} as RemoteTrustedSourceRecord;
  return body.record as RemoteTrustedSourceRecord;
}

function check(checks: CollectorGatewayConformanceReport["checks"], id: string, passed: boolean, message: string): void {
  checks.push({ id, passed, message });
}
