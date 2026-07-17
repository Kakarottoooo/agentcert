import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { EvidenceSigner } from "../src/signing.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { CONTROL_PLANE_MIGRATIONS, InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";
import { canonicalJson, generateSourceSigner, sha256, signDigest } from "../../onegent-runtime/src/trust-crypto.js";
import { TrustedActionRecorder } from "../../onegent-runtime/src/trusted-recorder.js";

const owner: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" };

describe("Customer-owned Remote Collector v0.2", () => {
  it("loads the remote collector migration", () => {
    expect(CONTROL_PLANE_MIGRATIONS.at(-1)).toBe("016_remote_collector.sql");
  });

  it("accepts a signed chain, safely replays duplicates, and server-attests reconciliation", async () => {
    const { service, projectId, apiAuth } = await setup();
    const signer = generateSourceSigner("customer-key-v1");
    await service.registerCollectorSourceKey(owner, projectId, {
      collectorId: "customer-collector", keyId: signer.keyId, publicKeyPem: signer.publicKeyPem,
    });
    const recorder = await recorderFor("remote-run-1", signer);
    await recorder.start({ test: "remote-collector" });
    await recorder.append("ACTION_CAPTURED", { actionId: "action-1" });
    await recorder.complete({ status: "verified" });
    const records = recorder.listRecords();

    const accepted = await service.appendTrustedCollectorRecords(apiAuth, projectId, "remote-run-1", { records });
    expect(accepted).toMatchObject({ accepted: 3, replayed: 0, ack: { sequence: 2 }, run: { status: "completed" } });
    const replay = await service.appendTrustedCollectorRecords(apiAuth, projectId, "remote-run-1", { records });
    expect(replay).toMatchObject({ accepted: 0, replayed: 3, ack: { sequence: 2 } });

    const receipt = recorder.createReceipt({
      mandateDigests: [], actionIds: ["action-1"],
      evidenceStrength: { schemaVersion: "agentcert.evidence_strength.v0.1", level: "recorded", claims: [], limitations: [] },
    });
    const reconciled = await service.reconcileTrustedCollectorRun(apiAuth, projectId, "remote-run-1", receipt);
    expect(reconciled).toMatchObject({
      reconciliation: { status: "complete", acceptedEventCount: 3, sourceKeyId: "customer-key-v1" },
      serverAttestation: { algorithm: "Ed25519" },
      run: { status: "reconciled" },
    });
  });

  it("rejects conflicting replay and records dropped-event alerts and incidents", async () => {
    const { service, projectId, apiAuth } = await setup();
    const signer = generateSourceSigner("customer-key-v1");
    await service.registerCollectorSourceKey(owner, projectId, { collectorId: "customer-collector", keyId: signer.keyId, publicKeyPem: signer.publicKeyPem });
    const recorder = await recorderFor("remote-run-dropped", signer);
    await recorder.start();
    await recorder.recordDropped(2, "offline queue overflow");
    await recorder.complete();
    const result = await service.appendTrustedCollectorRecords(apiAuth, projectId, "remote-run-dropped", { records: recorder.listRecords() });
    expect(result).toMatchObject({ run: { status: "degraded", droppedEventCount: 2 }, alerts: [{ kind: "events_dropped", severity: "critical" }] });
    expect(await service.listIncidents(apiAuth, projectId)).toMatchObject([{ type: "trusted_collector_events_dropped", severity: "high" }]);

    const tampered = structuredClone(recorder.listRecords()[0]);
    tampered.recordId = "conflicting-record";
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "remote-run-dropped", { records: [tampered] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 401, code: "trusted_record_signature_invalid" });
  });

  it("requires a signed run start and rolls back a rejected in-memory batch", async () => {
    const { service, projectId, apiAuth } = await setup();
    const signer = generateSourceSigner("customer-key-v1");
    await service.registerCollectorSourceKey(owner, projectId, { collectorId: "customer-collector", keyId: signer.keyId, publicKeyPem: signer.publicKeyPem });
    const recorder = await recorderFor("atomic-run", signer);
    await recorder.start();
    await recorder.append("ACTION_CAPTURED", { actionId: "action-1" });
    await recorder.complete();
    const records = recorder.listRecords();

    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "atomic-run", { records: [records[1]] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "invalid_start" });
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "atomic-run", { records: [records[0], records[2]] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "undeclared_gap" });
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "atomic-run", { records }))
      .resolves.toMatchObject({ accepted: 3, replayed: 0, run: { status: "completed" } });
  });

  it("allows exact replay but rejects new records after completion", async () => {
    const { service, projectId, apiAuth } = await setup();
    const signer = generateSourceSigner("customer-key-v1");
    await service.registerCollectorSourceKey(owner, projectId, { collectorId: "customer-collector", keyId: signer.keyId, publicKeyPem: signer.publicKeyPem });
    const recorder = await recorderFor("closed-run", signer);
    await recorder.start();
    await recorder.complete();
    const completed = recorder.listRecords();
    await service.appendTrustedCollectorRecords(apiAuth, projectId, "closed-run", { records: completed });
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "closed-run", { records: completed }))
      .resolves.toMatchObject({ accepted: 0, replayed: 2 });
    const late = structuredClone(completed.at(-1)!);
    late.recordId = "late-record";
    late.sequence = 2;
    late.occurredAt = new Date().toISOString();
    late.type = "ACTION_CAPTURED";
    late.previousEventHash = completed.at(-1)!.eventHash;
    late.payload = { actionId: "too-late" };
    late.payloadSha256 = sha256(canonicalJson(late.payload));
    const { eventHash: _oldHash, sourceSignature: _oldSignature, ...unsigned } = late;
    late.eventHash = sha256(canonicalJson(unsigned));
    late.sourceSignature = signDigest(late.eventHash, signer);
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "closed-run", { records: [late] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "run_closed" });
  });

  it("rotates customer keys without allowing a retired key to start a new run", async () => {
    const { service, projectId, apiAuth } = await setup();
    const first = generateSourceSigner("customer-key-v1");
    const second = generateSourceSigner("customer-key-v2");
    await service.registerCollectorSourceKey(owner, projectId, { collectorId: "customer-collector", keyId: first.keyId, publicKeyPem: first.publicKeyPem });
    await service.registerCollectorSourceKey(owner, projectId, { collectorId: "customer-collector", keyId: second.keyId, publicKeyPem: second.publicKeyPem, previousKeyId: first.keyId });
    expect(await service.listCollectorSourceKeys(owner, projectId)).toEqual(expect.arrayContaining([
      { keyId: "customer-key-v2", status: "active" },
      { keyId: "customer-key-v1", status: "retired" },
    ].map((item) => expect.objectContaining(item))));
    const oldRecorder = await recorderFor("new-run-with-old-key", first);
    await oldRecorder.start();
    await expect(service.appendTrustedCollectorRecords(apiAuth, projectId, "new-run-with-old-key", { records: oldRecorder.listRecords() }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "collector_key_retired" });
  });

  it("requires the dedicated collector management scope for API key rotation", async () => {
    const { service, projectId } = await setup();
    const signer = generateSourceSigner("scoped-key-v1");
    const input = { collectorId: "scoped-collector", keyId: signer.keyId, publicKeyPem: signer.publicKeyPem };
    await expect(service.registerCollectorSourceKey({ kind: "api_key", projectId, scopes: ["events:write"] }, projectId, input))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403 });
    await expect(service.registerCollectorSourceKey({ kind: "api_key", projectId, scopes: ["collector:manage"] }, projectId, input))
      .resolves.toMatchObject({ keyId: "scoped-key-v1", status: "active" });
  });
});

async function setup() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const service = new AgentCertControlPlane(
    new InMemoryControlPlaneStore(),
    new MemoryArtifactStore(),
    undefined,
    [],
    new EvidenceSigner("agentcert-server-test", privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  );
  const projectId = (await service.bootstrap(owner)).project.id;
  const apiAuth: AuthContext = { kind: "api_key", projectId, scopes: ["events:write", "runs:read"] };
  return { service, projectId, apiAuth };
}

async function recorderFor(runId: string, signer: ReturnType<typeof generateSourceSigner>) {
  return TrustedActionRecorder.open({
    runId,
    storageDirectory: await mkdtemp(join(tmpdir(), "agentcert-remote-collector-")),
    collector: { id: "customer-collector", version: "0.2.0", environment: "test" },
    signer,
  });
}
