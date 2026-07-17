import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CustomerSourceKeyRing,
  runCollectorGatewayConformance,
  startCustomerOwnedCollectorGateway,
  type RemoteCollectorAck,
  type RemoteCollectorTransport,
  type RemoteTrustedSourceRecord,
} from "../src/index.js";

describe("customer-owned collector gateway", () => {
  it("authenticates local writers and makes idempotent signed records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-gateway-"));
    const ring = await CustomerSourceKeyRing.create(join(directory, "keys.json"), "gateway-collector", "source-v1");
    const remote = new FakeRemoteCollector();
    const token = "local-gateway-token-at-least-24-chars";
    const gateway = await startCustomerOwnedCollectorGateway({ client: remote, keyRing: ring, gatewayToken: token, storageDirectory: join(directory, "queue") });
    try {
      expect((await fetch(`${gateway.baseUrl}/v1/flush`, { method: "POST" })).status).toBe(401);
      const start = await post(gateway.baseUrl, token, "/v1/runs/run-1/start", { payload: { workflow: "procurement" } });
      const first = await post(gateway.baseUrl, token, "/v1/runs/run-1/events", { type: "ACTION_CAPTURED", payload: { actionId: "action-1" }, idempotencyKey: "event-1" });
      const replay = await post(gateway.baseUrl, token, "/v1/runs/run-1/events", { type: "ACTION_CAPTURED", payload: { actionId: "action-1" }, idempotencyKey: "event-1" });
      expect(start.record).toMatchObject({ sequence: 0, type: "RUN_STARTED", sourceSignature: { keyId: "source-v1" } });
      expect(first.record).toMatchObject({ sequence: 1, type: "ACTION_CAPTURED" });
      expect(replay.record).toMatchObject({ sequence: 1, recordId: first.record.recordId });
      expect(remote.records).toHaveLength(2);
    } finally { await gateway.close(); }
  });

  it("replays its fsynced queue after process restart and reconciles a completed run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-gateway-restart-"));
    const storageDirectory = join(directory, "queue");
    const ring = await CustomerSourceKeyRing.create(join(directory, "keys.json"), "gateway-collector", "source-v1");
    const remote = new FakeRemoteCollector();
    const token = "local-gateway-token-at-least-24-chars";
    const first = await startCustomerOwnedCollectorGateway({ client: remote, keyRing: ring, gatewayToken: token, storageDirectory });
    remote.online = false;
    await post(first.baseUrl, token, "/v1/runs/recovery-run/start", { payload: {} });
    await post(first.baseUrl, token, "/v1/runs/recovery-run/complete", {
      payload: { status: "verified" },
      mandateDigests: ["a".repeat(64)],
      actionIds: ["action-1"],
      evidenceStrength: { schemaVersion: "agentcert.evidence_strength.v0.1", level: "recorded", claims: [], limitations: [] },
    });
    expect((await first.status()).pendingRecordCount).toBe(2);
    await first.close();

    remote.online = true;
    const restarted = await startCustomerOwnedCollectorGateway({ client: remote, keyRing: await CustomerSourceKeyRing.open(ring.filePath), gatewayToken: token, storageDirectory });
    try {
      expect(await restarted.status()).toMatchObject({ pendingRecordCount: 0, lastRemoteError: undefined });
      expect(remote.records).toHaveLength(2);
      expect(remote.reconciledRuns).toEqual(["recovery-run"]);
    } finally { await restarted.close(); }
  });

  it("passes the black-box gateway conformance suite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-gateway-conformance-"));
    const ring = await CustomerSourceKeyRing.create(join(directory, "keys.json"), "gateway-collector", "source-v1");
    const token = "local-gateway-token-at-least-24-chars";
    const gateway = await startCustomerOwnedCollectorGateway({ client: new FakeRemoteCollector(), keyRing: ring, gatewayToken: token, storageDirectory: join(directory, "queue") });
    try {
      const report = await runCollectorGatewayConformance({ baseUrl: gateway.baseUrl, gatewayToken: token });
      expect(report.passed).toBe(true);
      expect(report.checks).toHaveLength(9);
    } finally { await gateway.close(); }
  });
});

class FakeRemoteCollector implements RemoteCollectorTransport {
  online = true;
  records: RemoteTrustedSourceRecord[] = [];
  reconciledRuns: string[] = [];
  async registerSourceKey(): Promise<Record<string, unknown>> { this.assertOnline(); return { status: "active" }; }
  async append(_runId: string, records: RemoteTrustedSourceRecord[]): Promise<RemoteCollectorAck> {
    this.assertOnline();
    let accepted = 0;
    let replayed = 0;
    for (const record of records) {
      if (this.records.some((item) => item.eventHash === record.eventHash)) replayed += 1;
      else { this.records.push(structuredClone(record)); accepted += 1; }
    }
    const last = records.at(-1)!;
    return { schemaVersion: "agentcert.remote_collector_ack.v0.2", accepted, replayed, ack: { sequence: last.sequence, eventHash: last.eventHash }, alerts: [], run: {} };
  }
  async heartbeat(): Promise<Record<string, unknown>> { this.assertOnline(); return { accepted: true }; }
  async reconcile(runId: string): Promise<Record<string, unknown>> { this.assertOnline(); this.reconciledRuns.push(runId); return { status: "complete" }; }
  private assertOnline(): void { if (!this.online) throw new Error("remote offline"); }
}

async function post(baseUrl: string, token: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json() as { record: RemoteTrustedSourceRecord; [key: string]: unknown };
  expect(response.status).toBe(202);
  return value;
}
