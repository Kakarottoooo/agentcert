import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileMandateStore,
  TrustedActionRecorder,
  assessEvidenceStrength,
  assertMandateAuthorizesAction,
  generateSourceSigner,
  issueActionMandate,
  sha256,
  validateTrustedJournal,
  verifyActionMandate,
  verifyTrustedRunReceipt,
  canonicalJson,
} from "../src/index.js";

function mandateInput() {
  return {
    mandateId: "mandate-po-4850",
    issuer: { id: "procurement-owner@example.test", type: "human" as const },
    subject: { principalId: "procurement-agent", agentVersion: "1.0.0" },
    scope: {
      actionTypes: ["SUBMIT" as const],
      targetSystems: ["MockERP"],
      permissions: ["MockERP:SUBMIT"],
      businessObjectIds: ["PO-4850"],
      currencies: ["USD"],
      maxAmount: 5_000,
    },
    expectedOutcome: { status: "SUBMITTED" },
    policySha256: sha256("procurement-policy-v1"),
    validFrom: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    issuedAt: "2026-07-17T00:00:00.000Z",
  };
}

function actionInput() {
  return {
    sourceAgentName: "ProcurementAgent",
    principal: { id: "procurement-agent", type: "agent" as const, version: "1.0.0" },
    requestedPermissions: ["MockERP:SUBMIT"],
    mandateId: "mandate-po-4850",
    actionType: "SUBMIT" as const,
    targetSystem: "MockERP",
    title: "Submit purchase order",
    description: "Submit the approved purchase order.",
    businessObjectType: "purchase_order",
    businessObjectId: "PO-4850",
    amount: 4_850,
    currency: "USD",
    proposedAfterState: { status: "SUBMITTED" },
  };
}

describe("action mandates", () => {
  it("uses deterministic canonical JSON and rejects ambiguous numeric values", () => {
    expect(canonicalJson({ z: -0, a: { y: 2, x: 1 }, omitted: undefined })).toBe('{"a":{"x":1,"y":2},"z":0}');
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("non-finite");
  });

  it("signs, verifies, freezes, persists, and refuses mutation", async () => {
    const signer = generateSourceSigner("customer-key-1");
    const mandate = issueActionMandate(mandateInput(), signer);
    expect(Object.isFrozen(mandate.scope)).toBe(true);
    expect(verifyActionMandate(mandate, signer.publicKeyPem, new Date("2026-07-17T12:00:00.000Z"))).toMatchObject({ valid: true });
    expect(() => assertMandateAuthorizesAction(mandate, actionInput())).not.toThrow();

    const directory = await mkdtemp(join(tmpdir(), "agentcert-mandates-"));
    const store = await FileMandateStore.open(join(directory, "mandates.jsonl"));
    await store.put(mandate);
    await expect(store.put({ ...mandate, digestSha256: "f".repeat(64) })).rejects.toThrow("immutable");
    const reopened = await FileMandateStore.open(join(directory, "mandates.jsonl"));
    expect((await reopened.get(mandate.mandateId))?.digestSha256).toBe(mandate.digestSha256);
  });

  it("rejects actions outside principal, amount, permission, and expected-state boundaries", () => {
    const signer = generateSourceSigner("customer-key-1");
    const mandate = issueActionMandate(mandateInput(), signer);
    expect(() => assertMandateAuthorizesAction(mandate, { ...actionInput(), amount: 6_000 })).toThrow("exceeds");
    expect(() => assertMandateAuthorizesAction(mandate, { ...actionInput(), requestedPermissions: ["MockERP:PAY"] })).toThrow("does not grant");
    expect(() => assertMandateAuthorizesAction(mandate, { ...actionInput(), principal: { id: "other-agent", type: "agent" } })).toThrow("subject");
    expect(() => assertMandateAuthorizesAction(mandate, { ...actionInput(), proposedAfterState: { status: "DRAFT" } })).toThrow("expected outcome");
  });
});

describe("trusted action recorder", () => {
  it("writes a signed ordered hash chain and resumes an at-least-once persistent queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-recorder-"));
    const signer = generateSourceSigner("customer-key-1");
    const recorder = await openRecorder(directory, signer);
    await recorder.start({ agent: "procurement-agent" });
    await Promise.all([
      recorder.append("ACTION_CAPTURED", { actionId: "act-1" }),
      recorder.append("APPROVAL_REQUESTED", { actionId: "act-1" }),
      recorder.append("ACTION_APPROVED", { actionId: "act-1" }),
    ]);
    await recorder.complete({ outcome: "verified" });

    const records = recorder.listRecords();
    expect(records.map((record) => record.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(recorder.validation()).toMatchObject({ valid: true, complete: true, sourceSigned: true, droppedEventCount: 0 });
    const delivered: number[] = [];
    await recorder.flush({ name: "test", write: async (record) => { delivered.push(record.sequence); } });
    expect(delivered).toEqual([0, 1, 2, 3, 4]);

    const reopened = await openRecorder(directory, signer);
    expect(reopened.pendingRecords()).toEqual([]);
    expect(reopened.validation().valid).toBe(true);
    const receipt = recorder.createReceipt({
      mandateDigests: ["a".repeat(64)],
      actionIds: ["act-1"],
      evidenceStrength: assessEvidenceStrength({ journal: recorder.validation(), mandateVerified: true, adapterControlled: true, outcomeVerified: true }),
    });
    expect(verifyTrustedRunReceipt(receipt)).toMatchObject({ valid: true, digestMatches: true, signatureMatches: true, collectorKeyMatches: true });
    expect(verifyTrustedRunReceipt({ ...receipt, actionIds: ["act-tampered"] }).valid).toBe(false);
  });

  it("retains unacknowledged events after sink failure and resumes from the durable acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-queue-"));
    const signer = generateSourceSigner("customer-key-1");
    const recorder = await openRecorder(directory, signer);
    await recorder.start();
    await recorder.append("ACTION_CAPTURED", { actionId: "act-1" });
    await recorder.complete();
    await expect(recorder.flush({ name: "failing", write: async (record) => {
      if (record.sequence === 1) throw new Error("offline");
    } })).rejects.toThrow("offline");

    const reopened = await openRecorder(directory, signer);
    expect(reopened.pendingRecords().map((record) => record.sequence)).toEqual([1, 2]);
  });

  it("makes declared drops observable and downgrades evidence strength", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-drops-"));
    const signer = generateSourceSigner("customer-key-1");
    const recorder = await openRecorder(directory, signer);
    await recorder.start();
    await recorder.recordDropped(2, "producer queue overflow");
    await recorder.complete();
    const validation = recorder.validation();
    expect(validation).toMatchObject({ valid: true, complete: true, droppedEventCount: 2 });
    expect(validation.gaps).toEqual([{ afterSequence: 0, beforeSequence: 3, missing: 2, declared: true }]);
    expect(assessEvidenceStrength({ journal: validation, mandateVerified: true, adapterControlled: true, outcomeVerified: true }).level).toBe("reported");
  });

  it("recovers a torn final journal write and records the recovery limitation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-recovery-"));
    const signer = generateSourceSigner("customer-key-1");
    const recorder = await openRecorder(directory, signer);
    await recorder.start();
    await recorder.append("ACTION_CAPTURED", { actionId: "act-1" });
    await appendFile(recorder.journalPath, '{"partial":');

    const recovered = await openRecorder(directory, signer);
    await recovered.start();
    await recovered.complete();
    expect(recovered.listRecords().some((record) => record.type === "JOURNAL_RECOVERED")).toBe(true);
    expect(recovered.validation()).toMatchObject({ valid: true, complete: true, droppedEventCount: 1 });
  });

  it("detects duplicate, missing, tampered, and invalidly signed records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-tamper-"));
    const signer = generateSourceSigner("customer-key-1");
    const recorder = await openRecorder(directory, signer);
    await recorder.start();
    await recorder.append("ACTION_CAPTURED", { actionId: "act-1" });
    await recorder.complete();
    const records = recorder.listRecords();
    const duplicate = structuredClone(records[1]);
    const tampered = structuredClone(records[2]);
    tampered.payload = { changed: true };
    tampered.eventHash = "f".repeat(64);
    const validation = validateTrustedJournal([records[0], duplicate, duplicate, tampered], signer.publicKeyPem);
    expect(validation.valid).toBe(false);
    expect(validation.duplicateSequences).toContain(1);
    expect(validation.duplicateRecordIds).toContain(duplicate.recordId);
    expect(validation.hashMismatches.length).toBeGreaterThan(0);
    expect(validation.signatureFailures.length).toBeGreaterThan(0);
  });
});

async function openRecorder(directory: string, signer: ReturnType<typeof generateSourceSigner>) {
  return TrustedActionRecorder.open({
    runId: "trusted-run-1",
    storageDirectory: directory,
    collector: { id: "agentcert-recorder", version: "0.1.0", environment: "test" },
    signer,
    now: () => new Date("2026-07-17T12:00:00.000Z"),
  });
}
