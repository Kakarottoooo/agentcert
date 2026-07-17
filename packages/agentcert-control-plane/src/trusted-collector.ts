import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./signing.js";
import type { CollectorSourceKeyRecord, TrustedSourceRecord } from "./types.js";

export interface CollectorKeyRegistrationInput {
  collectorId: string;
  keyId: string;
  publicKeyPem: string;
  publicKeySha256: string;
  previousKeyId?: string;
}

export interface CollectorHeartbeatPayload {
  schemaVersion: "agentcert.collector_heartbeat.v0.2";
  collectorId: string;
  sourceKeyId: string;
  runId?: string;
  occurredAt: string;
  pendingRecordCount: number;
  lastAckSequence?: number;
}

export interface SignedCollectorHeartbeat {
  payload: CollectorHeartbeatPayload;
  payloadSha256: string;
  signature: { algorithm: "Ed25519"; keyId: string; signature: string };
}

export interface TrustedRunReceiptInput {
  schemaVersion: "agentcert.trusted_run_receipt.v0.1";
  runId: string;
  collector: { id: string; keyId: string; publicKeySha256: string; [key: string]: unknown };
  eventCount: number;
  droppedEventCount: number;
  firstEventHash: string;
  lastEventHash: string;
  receiptSha256: string;
  sourceSignature: { algorithm: "Ed25519"; keyId: string; signature: string };
  [key: string]: unknown;
}

export function parseCollectorKeyRegistration(input: unknown): CollectorKeyRegistrationInput {
  const body = object(input, "collector key registration");
  const collectorId = identifier(body.collectorId, "collectorId");
  const keyId = identifier(body.keyId, "keyId");
  const publicKeyPem = requiredString(body.publicKeyPem, "publicKeyPem", 8_192);
  let key;
  try { key = createPublicKey(publicKeyPem); }
  catch { throw new Error("publicKeyPem must contain a valid Ed25519 public key."); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("publicKeyPem must contain a valid Ed25519 public key.");
  const normalized = key.export({ type: "spki", format: "pem" }).toString();
  return {
    collectorId,
    keyId,
    publicKeyPem: normalized,
    publicKeySha256: sha256(key.export({ type: "spki", format: "der" })),
    previousKeyId: body.previousKeyId === undefined ? undefined : identifier(body.previousKeyId, "previousKeyId"),
  };
}

export function parseTrustedRecordBatch(input: unknown, expectedRunId: string): TrustedSourceRecord[] {
  const body = object(input, "trusted record batch");
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 100) {
    throw new Error("records must contain 1 to 100 trusted action records.");
  }
  return body.records.map((value, index) => parseTrustedRecord(value, expectedRunId, index));
}

export function verifyTrustedSourceRecord(record: TrustedSourceRecord, key: CollectorSourceKeyRecord): void {
  if (key.status === "revoked") throw new Error(`Collector source key ${key.keyId} is revoked.`);
  if (record.collector.keyId !== key.keyId || record.sourceSignature.keyId !== key.keyId) throw new Error("Trusted record source key does not match the registered collector key.");
  if (record.collector.id !== key.collectorId || record.collector.publicKeySha256 !== key.publicKeySha256) throw new Error("Trusted record collector identity does not match the registered source key.");
  if (sha256(canonicalJson(record.payload)) !== record.payloadSha256) throw new Error(`Trusted record ${record.sequence} payload digest is invalid.`);
  const { eventHash: _eventHash, sourceSignature: _signature, ...unsigned } = record;
  if (sha256(canonicalJson(unsigned)) !== record.eventHash) throw new Error(`Trusted record ${record.sequence} event hash is invalid.`);
  if (!verifyDigest(record.eventHash, record.sourceSignature, key.publicKeyPem)) throw new Error(`Trusted record ${record.sequence} source signature is invalid.`);
}

export function parseSignedCollectorHeartbeat(input: unknown): SignedCollectorHeartbeat {
  const body = object(input, "collector heartbeat");
  const payloadBody = object(body.payload, "collector heartbeat payload");
  const payload: CollectorHeartbeatPayload = {
    schemaVersion: literal(payloadBody.schemaVersion, "agentcert.collector_heartbeat.v0.2", "payload.schemaVersion"),
    collectorId: identifier(payloadBody.collectorId, "payload.collectorId"),
    sourceKeyId: identifier(payloadBody.sourceKeyId, "payload.sourceKeyId"),
    runId: payloadBody.runId === undefined ? undefined : identifier(payloadBody.runId, "payload.runId"),
    occurredAt: timestamp(payloadBody.occurredAt, "payload.occurredAt"),
    pendingRecordCount: nonNegativeInteger(payloadBody.pendingRecordCount, "payload.pendingRecordCount"),
    lastAckSequence: payloadBody.lastAckSequence === undefined ? undefined : nonNegativeInteger(payloadBody.lastAckSequence, "payload.lastAckSequence"),
  };
  const signatureBody = object(body.signature, "collector heartbeat signature");
  return {
    payload,
    payloadSha256: digest(body.payloadSha256, "payloadSha256"),
    signature: {
      algorithm: literal(signatureBody.algorithm, "Ed25519", "signature.algorithm"),
      keyId: identifier(signatureBody.keyId, "signature.keyId"),
      signature: requiredString(signatureBody.signature, "signature.signature", 512),
    },
  };
}

export function verifyCollectorHeartbeat(heartbeat: SignedCollectorHeartbeat, key: CollectorSourceKeyRecord): void {
  if (key.status !== "active") throw new Error(`Collector heartbeat requires an active source key; ${key.keyId} is ${key.status}.`);
  if (heartbeat.payload.collectorId !== key.collectorId || heartbeat.payload.sourceKeyId !== key.keyId || heartbeat.signature.keyId !== key.keyId) {
    throw new Error("Collector heartbeat identity does not match the active source key.");
  }
  const actualDigest = sha256(canonicalJson(heartbeat.payload));
  if (actualDigest !== heartbeat.payloadSha256 || !verifyDigest(actualDigest, heartbeat.signature, key.publicKeyPem)) {
    throw new Error("Collector heartbeat signature is invalid.");
  }
}

export function parseTrustedRunReceipt(input: unknown): TrustedRunReceiptInput {
  const body = object(input, "trusted run receipt");
  const collector = object(body.collector, "receipt.collector");
  const signature = object(body.sourceSignature, "receipt.sourceSignature");
  return {
    ...body,
    schemaVersion: literal(body.schemaVersion, "agentcert.trusted_run_receipt.v0.1", "schemaVersion"),
    runId: identifier(body.runId, "runId"),
    collector: { ...collector, id: identifier(collector.id, "collector.id"), keyId: identifier(collector.keyId, "collector.keyId"), publicKeySha256: digest(collector.publicKeySha256, "collector.publicKeySha256") },
    eventCount: nonNegativeInteger(body.eventCount, "eventCount"),
    droppedEventCount: nonNegativeInteger(body.droppedEventCount, "droppedEventCount"),
    firstEventHash: digest(body.firstEventHash, "firstEventHash"),
    lastEventHash: digest(body.lastEventHash, "lastEventHash"),
    receiptSha256: digest(body.receiptSha256, "receiptSha256"),
    sourceSignature: { algorithm: literal(signature.algorithm, "Ed25519", "sourceSignature.algorithm"), keyId: identifier(signature.keyId, "sourceSignature.keyId"), signature: requiredString(signature.signature, "sourceSignature.signature", 512) },
  };
}

export function verifyTrustedRunReceiptInput(receipt: TrustedRunReceiptInput, key: CollectorSourceKeyRecord): void {
  if (key.status === "revoked") throw new Error(`Collector source key ${key.keyId} is revoked.`);
  if (receipt.collector.id !== key.collectorId || receipt.collector.keyId !== key.keyId || receipt.collector.publicKeySha256 !== key.publicKeySha256 || receipt.sourceSignature.keyId !== key.keyId) {
    throw new Error("Trusted run receipt identity does not match the registered source key.");
  }
  const { receiptSha256: _digest, sourceSignature: _signature, ...payload } = receipt;
  const actualDigest = sha256(canonicalJson(payload));
  if (actualDigest !== receipt.receiptSha256 || !verifyDigest(actualDigest, receipt.sourceSignature, key.publicKeyPem)) {
    throw new Error("Trusted run receipt signature is invalid.");
  }
}

function parseTrustedRecord(input: unknown, expectedRunId: string, index: number): TrustedSourceRecord {
  const body = object(input, `records[${index}]`);
  const collector = object(body.collector, `records[${index}].collector`);
  const signature = object(body.sourceSignature, `records[${index}].sourceSignature`);
  const record: TrustedSourceRecord = {
    schemaVersion: literal(body.schemaVersion, "agentcert.trusted_action_record.v0.1", `records[${index}].schemaVersion`),
    recordId: identifier(body.recordId, `records[${index}].recordId`),
    runId: identifier(body.runId, `records[${index}].runId`),
    sequence: nonNegativeInteger(body.sequence, `records[${index}].sequence`),
    occurredAt: timestamp(body.occurredAt, `records[${index}].occurredAt`),
    type: identifier(body.type, `records[${index}].type`),
    collector: {
      id: identifier(collector.id, `records[${index}].collector.id`),
      version: requiredString(collector.version, `records[${index}].collector.version`, 120),
      environment: requiredString(collector.environment, `records[${index}].collector.environment`, 120),
      keyId: identifier(collector.keyId, `records[${index}].collector.keyId`),
      publicKeySha256: digest(collector.publicKeySha256, `records[${index}].collector.publicKeySha256`),
    },
    previousEventHash: body.previousEventHash === undefined ? undefined : digest(body.previousEventHash, `records[${index}].previousEventHash`),
    payload: object(body.payload, `records[${index}].payload`),
    payloadSha256: digest(body.payloadSha256, `records[${index}].payloadSha256`),
    eventHash: digest(body.eventHash, `records[${index}].eventHash`),
    sourceSignature: {
      algorithm: literal(signature.algorithm, "Ed25519", `records[${index}].sourceSignature.algorithm`),
      keyId: identifier(signature.keyId, `records[${index}].sourceSignature.keyId`),
      signature: requiredString(signature.signature, `records[${index}].sourceSignature.signature`, 512),
    },
  };
  if (record.runId !== expectedRunId) throw new Error(`records[${index}].runId does not match the route runId.`);
  return record;
}

function verifyDigest(value: string, signature: { algorithm: "Ed25519"; signature: string }, publicKeyPem: string): boolean {
  try { return verify(null, Buffer.from(value, "hex"), createPublicKey(publicKeyPem), Buffer.from(signature.signature, "base64url")); }
  catch { return false; }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a non-empty string no longer than ${max} characters.`);
  return value;
}

function identifier(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw new Error(`${field} must use URL-safe identifier characters.`);
  return parsed;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 hex digest.`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date-time.`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer.`);
  return value;
}

function literal<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`${field} must be ${expected}.`);
  return expected;
}
