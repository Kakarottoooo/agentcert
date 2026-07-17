import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CustomerSourceKeyRing,
  DurableRemoteCollectorQueue,
  RemoteCollectorClient,
  type RemoteTrustedSourceRecord,
} from "../src/index.js";

describe("Customer-owned remote collector SDK", () => {
  it("keeps private material in the local key ring and rotates public registrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-keyring-"));
    const path = join(directory, "source-keys.json");
    const ring = await CustomerSourceKeyRing.create(path, "customer-collector", "source-v1");

    const registration = ring.registration();
    expect(registration).toMatchObject({ collectorId: "customer-collector", keyId: "source-v1" });
    expect(JSON.stringify(registration)).not.toContain("PRIVATE KEY");
    expect(await readFile(path, "utf8")).toContain("PRIVATE KEY");

    const rotated = await ring.rotate("source-v2");
    expect(rotated.previousKeyId).toBe("source-v1");
    expect(ring.registration(rotated.previousKeyId)).toMatchObject({ keyId: "source-v2", previousKeyId: "source-v1" });
    expect((await CustomerSourceKeyRing.open(path)).activeSigner().keyId).toBe("source-v2");
  });

  it("does not advance its durable ACK while the service is offline and replays after recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-remote-queue-"));
    const record = fixtureRecord();
    const queue = new DurableRemoteCollectorQueue(directory, record.runId);
    await queue.enqueue(record);
    let online = false;
    const request = vi.fn(async () => online
      ? new Response(JSON.stringify({ accepted: 1, replayed: 0, ack: { sequence: 0, eventHash: record.eventHash }, alerts: [], run: {} }), { status: 200 })
      : new Response(JSON.stringify({ code: "offline", error: "offline" }), { status: 503 }));
    const client = new RemoteCollectorClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_secret", fetch: request as typeof fetch });

    await expect(queue.replay(client)).rejects.toThrow("offline");
    expect(await queue.pending()).toHaveLength(1);
    online = true;
    await expect(queue.replay(client)).resolves.toMatchObject({ delivered: 1, ack: { sequence: 0 } });
    expect(await queue.pending()).toHaveLength(0);
    expect(await readFile(queue.journalPath, "utf8")).not.toContain("ac_secret");
  });

  it("signs heartbeats without sending private key material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-heartbeat-"));
    const signer = (await CustomerSourceKeyRing.create(join(directory, "keys.json"), "collector", "key-v1")).activeSigner();
    const request = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const client = new RemoteCollectorClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_secret", fetch: request as typeof fetch });
    await client.heartbeat({ collectorId: "collector", signer, pendingRecordCount: 3, lastAckSequence: 4 });

    const body = String((request.mock.calls[0]?.[1] as RequestInit).body);
    expect(body).toContain("agentcert.collector_heartbeat.v0.2");
    expect(body).toContain("signature");
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toContain("ac_secret");
  });

  it("rejects an ACK that does not bind to the local journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-remote-ack-"));
    const record = fixtureRecord();
    const queue = new DurableRemoteCollectorQueue(directory, record.runId);
    await queue.enqueue(record);
    await writeFile(queue.ackPath, JSON.stringify({ sequence: 99, eventHash: "d".repeat(64) }), "utf8");
    await expect(queue.pending()).rejects.toThrow("does not match the local journal");
  });

  it("serializes concurrent replay so one record is not delivered twice locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-remote-concurrent-"));
    const record = fixtureRecord();
    const queue = new DurableRemoteCollectorQueue(directory, record.runId);
    await queue.enqueue(record);
    const append = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { schemaVersion: "agentcert.remote_collector_ack.v0.2" as const, accepted: 1, replayed: 0, ack: { sequence: 0, eventHash: record.eventHash }, alerts: [], run: {} };
    });

    const results = await Promise.all([queue.replay({ append }), queue.replay({ append })]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(results.map((item) => item.delivered).sort()).toEqual([0, 1]);
  });
});

function fixtureRecord(): RemoteTrustedSourceRecord {
  return {
    schemaVersion: "agentcert.trusted_action_record.v0.1",
    recordId: "record-1",
    runId: "run-1",
    sequence: 0,
    occurredAt: "2026-07-17T00:00:00.000Z",
    type: "RUN_STARTED",
    collector: { id: "collector", version: "0.2.0", environment: "test", keyId: "key-v1", publicKeySha256: "a".repeat(64) },
    payload: {},
    payloadSha256: "b".repeat(64),
    eventHash: "c".repeat(64),
    sourceSignature: { algorithm: "Ed25519", keyId: "key-v1", signature: "fixture" },
  };
}
