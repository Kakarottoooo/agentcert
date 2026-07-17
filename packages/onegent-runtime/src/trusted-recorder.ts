import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CollectorIdentity,
  EvidenceStrengthAssessment,
  JournalGap,
  JournalValidation,
  SourceSigner,
  TrustedActionRecord,
  TrustedRecorderSink,
  TrustedRecordType,
  TrustedRunReceipt,
} from "./trust-types.js";
import { canonicalJson, publicKeyPemFor, publicKeySha256, sha256, signDigest, verifyDigest } from "./trust-crypto.js";

interface RecorderAck {
  sequence: number;
  eventHash: string;
}

export interface TrustedActionRecorderOptions {
  runId: string;
  storageDirectory: string;
  collector: Omit<CollectorIdentity, "keyId" | "publicKeySha256">;
  signer: SourceSigner;
  now?: () => Date;
}

export interface ReceiptInput {
  mandateDigests: string[];
  actionIds: string[];
  evidenceStrength: EvidenceStrengthAssessment;
}

export interface TrustedRunReceiptVerification {
  valid: boolean;
  digestMatches: boolean;
  signatureMatches: boolean;
  collectorKeyMatches: boolean;
  errors: string[];
}

export class TrustedActionRecorder {
  readonly journalPath: string;
  readonly ackPath: string;
  readonly collector: CollectorIdentity;
  readonly sourcePublicKeyPem: string;
  private readonly records: TrustedActionRecord[];
  private readonly signer: SourceSigner;
  private readonly now: () => Date;
  private recoveredTailBytes: number;
  private ackSequence: number;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly runId: string,
    storageDirectory: string,
    collector: CollectorIdentity,
    signer: SourceSigner,
    publicKeyPem: string,
    records: TrustedActionRecord[],
    recoveredTailBytes: number,
    ackSequence: number,
    now: () => Date,
  ) {
    const base = safeFileName(runId);
    this.journalPath = join(resolve(storageDirectory), `${base}.journal.jsonl`);
    this.ackPath = join(resolve(storageDirectory), `${base}.ack.json`);
    this.collector = collector;
    this.signer = signer;
    this.sourcePublicKeyPem = publicKeyPem;
    this.records = records;
    this.recoveredTailBytes = recoveredTailBytes;
    this.ackSequence = ackSequence;
    this.now = now;
  }

  static async open(options: TrustedActionRecorderOptions): Promise<TrustedActionRecorder> {
    required(options.runId, "runId");
    required(options.collector.id, "collector.id");
    required(options.collector.version, "collector.version");
    required(options.collector.environment, "collector.environment");
    required(options.signer.keyId, "signer.keyId");
    const storage = resolve(options.storageDirectory);
    await mkdir(storage, { recursive: true });
    const publicKeyPem = publicKeyPemFor(options.signer);
    const collector: CollectorIdentity = {
      ...structuredClone(options.collector),
      keyId: options.signer.keyId,
      publicKeySha256: publicKeySha256(publicKeyPem),
    };
    const journalPath = join(storage, `${safeFileName(options.runId)}.journal.jsonl`);
    const recovered = await recoverJournal(journalPath);
    for (const record of recovered.records) {
      if (record.runId !== options.runId) throw new Error(`Recorder journal contains a record for run ${record.runId}.`);
      if (canonicalJson(record.collector) !== canonicalJson(collector)) throw new Error("Recorder collector identity does not match the existing journal.");
    }
    const ackSequence = await readAck(join(storage, `${safeFileName(options.runId)}.ack.json`), recovered.records);
    return new TrustedActionRecorder(
      options.runId,
      storage,
      collector,
      options.signer,
      publicKeyPem,
      recovered.records,
      recovered.recoveredTailBytes,
      ackSequence,
      options.now ?? (() => new Date()),
    );
  }

  async start(payload: Record<string, unknown> = {}): Promise<TrustedActionRecord> {
    if (this.records.length) {
      const first = this.records[0];
      if (first.type !== "RUN_STARTED") throw new Error("Recorder journal does not begin with RUN_STARTED.");
      if (this.recoveredTailBytes > 0 && this.records.at(-1)?.type !== "RUN_COMPLETED") {
        const recoveredTailBytes = this.recoveredTailBytes;
        await this.append("JOURNAL_RECOVERED", { recoveredTailBytes, droppedFragments: 1 });
        this.recoveredTailBytes = 0;
      }
      return structuredClone(first);
    }
    const started = await this.appendAt("RUN_STARTED", payload, { absoluteSequence: 0 });
    if (this.recoveredTailBytes > 0) {
      const recoveredTailBytes = this.recoveredTailBytes;
      await this.append("JOURNAL_RECOVERED", { recoveredTailBytes, droppedFragments: 1 });
      this.recoveredTailBytes = 0;
    }
    return started;
  }

  async append(type: Exclude<TrustedRecordType, "RUN_STARTED" | "RUN_COMPLETED">, payload: Record<string, unknown> = {}): Promise<TrustedActionRecord> {
    if (!this.records.length) throw new Error("Recorder must start the run before appending events.");
    if (this.records.at(-1)?.type === "RUN_COMPLETED") throw new Error("Recorder run is already complete.");
    return this.appendAt(type, payload);
  }

  async recordDropped(count: number, reason: string): Promise<TrustedActionRecord> {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Dropped event count must be a positive safe integer.");
    required(reason, "dropped event reason");
    return this.appendAt("EVENTS_DROPPED", { count, reason }, { skippedSequences: count });
  }

  async complete(payload: Record<string, unknown> = {}): Promise<TrustedActionRecord> {
    if (!this.records.length) throw new Error("Recorder must start the run before completion.");
    const existing = this.records.at(-1);
    if (existing?.type === "RUN_COMPLETED") return structuredClone(existing);
    return this.appendAt("RUN_COMPLETED", payload);
  }

  validation(): JournalValidation {
    return validateTrustedJournal(this.records, this.sourcePublicKeyPem, this.recoveredTailBytes);
  }

  listRecords(): TrustedActionRecord[] {
    return structuredClone(this.records);
  }

  pendingRecords(): TrustedActionRecord[] {
    return structuredClone(this.records.filter((record) => record.sequence > this.ackSequence));
  }

  async flush(sink: TrustedRecorderSink): Promise<number> {
    let delivered = 0;
    for (const record of this.records.filter((item) => item.sequence > this.ackSequence)) {
      await sink.write(structuredClone(record));
      await this.persistAck({ sequence: record.sequence, eventHash: record.eventHash });
      this.ackSequence = record.sequence;
      delivered += 1;
    }
    return delivered;
  }

  createReceipt(input: ReceiptInput): TrustedRunReceipt {
    const validation = this.validation();
    if (!validation.complete) throw new Error("Cannot create a trusted run receipt before RUN_COMPLETED.");
    const first = this.records[0];
    const last = this.records.at(-1)!;
    const payload = {
      schemaVersion: "agentcert.trusted_run_receipt.v0.1" as const,
      runId: this.runId,
      collector: this.collector,
      startedAt: first.occurredAt,
      completedAt: last.occurredAt,
      eventCount: this.records.length,
      droppedEventCount: validation.droppedEventCount,
      firstEventHash: first.eventHash,
      lastEventHash: last.eventHash,
      mandateDigests: [...new Set(input.mandateDigests)].sort(),
      actionIds: [...new Set(input.actionIds)].sort(),
      journal: validation,
      evidenceStrength: input.evidenceStrength,
      sourcePublicKeyPem: this.sourcePublicKeyPem,
    };
    const receiptSha256 = sha256(canonicalJson(payload));
    return { ...payload, receiptSha256, sourceSignature: signDigest(receiptSha256, this.signer) };
  }

  private async appendAt(
    type: TrustedRecordType,
    payload: Record<string, unknown>,
    options: { absoluteSequence?: number; skippedSequences?: number } = {},
  ): Promise<TrustedActionRecord> {
    let result: TrustedActionRecord | undefined;
    const operation = this.writeChain.then(async () => {
      const previous = this.records.at(-1);
      const sequence = options.absoluteSequence ?? (previous?.sequence ?? -1) + 1 + (options.skippedSequences ?? 0);
      if (previous && sequence <= previous.sequence) throw new Error(`Sequence ${sequence} must be greater than ${previous.sequence}.`);
      const occurredAt = this.now().toISOString();
      const payloadCopy = structuredClone(payload);
      const payloadSha256 = sha256(canonicalJson(payloadCopy));
      const unsigned = {
        schemaVersion: "agentcert.trusted_action_record.v0.1" as const,
        recordId: randomUUID(),
        runId: this.runId,
        sequence,
        occurredAt,
        type,
        collector: this.collector,
        previousEventHash: previous?.eventHash,
        payload: payloadCopy,
        payloadSha256,
      };
      const eventHash = sha256(canonicalJson(unsigned));
      result = { ...unsigned, eventHash, sourceSignature: signDigest(eventHash, this.signer) };
      await appendDurably(this.journalPath, `${JSON.stringify(result)}\n`);
      this.records.push(result);
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
    return structuredClone(result!);
  }

  private async persistAck(ack: RecorderAck): Promise<void> {
    const temporary = `${this.ackPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(ack), "utf8");
    await rename(temporary, this.ackPath);
  }
}

export function verifyTrustedRunReceipt(receipt: TrustedRunReceipt): TrustedRunReceiptVerification {
  const errors: string[] = [];
  const { receiptSha256, sourceSignature, ...payload } = receipt;
  const actualDigest = sha256(canonicalJson(payload));
  const digestMatches = actualDigest === receiptSha256;
  if (!digestMatches) errors.push("Trusted run receipt digest does not match its payload.");
  const collectorKeyMatches = receipt.collector.keyId === sourceSignature.keyId
    && receipt.collector.publicKeySha256 === publicKeySha256(receipt.sourcePublicKeyPem);
  if (!collectorKeyMatches) errors.push("Trusted run receipt collector identity does not match its source key.");
  const signatureMatches = verifyDigest(receiptSha256, sourceSignature, receipt.sourcePublicKeyPem);
  if (!signatureMatches) errors.push("Trusted run receipt source signature is invalid.");
  return { valid: digestMatches && collectorKeyMatches && signatureMatches, digestMatches, signatureMatches, collectorKeyMatches, errors };
}

export function validateTrustedJournal(
  records: TrustedActionRecord[],
  publicKeyPem: string,
  recoveredTailBytes = 0,
): JournalValidation {
  const gaps: JournalGap[] = [];
  const duplicateSequences: number[] = [];
  const duplicateRecordIds: string[] = [];
  const hashMismatches: number[] = [];
  const signatureFailures: number[] = [];
  const errors: string[] = [];
  const sequences = new Set<number>();
  const recordIds = new Set<string>();
  let droppedEventCount = recoveredTailBytes > 0 ? 1 : 0;

  for (const [index, record] of records.entries()) {
    if (sequences.has(record.sequence)) duplicateSequences.push(record.sequence);
    sequences.add(record.sequence);
    if (recordIds.has(record.recordId)) duplicateRecordIds.push(record.recordId);
    recordIds.add(record.recordId);
    const previous = records[index - 1];
    if (previous) {
      if (record.sequence > previous.sequence + 1) {
        const missing = record.sequence - previous.sequence - 1;
        const declared = record.type === "EVENTS_DROPPED" && record.payload.count === missing;
        gaps.push({ afterSequence: previous.sequence, beforeSequence: record.sequence, missing, declared });
        if (declared) droppedEventCount += missing;
      } else if (record.sequence <= previous.sequence) {
        errors.push(`Sequence ${record.sequence} is not strictly greater than ${previous.sequence}.`);
      }
      if (record.previousEventHash !== previous.eventHash) hashMismatches.push(record.sequence);
    } else {
      if (record.sequence !== 0) gaps.push({ afterSequence: -1, beforeSequence: record.sequence, missing: record.sequence, declared: false });
      if (record.previousEventHash !== undefined) hashMismatches.push(record.sequence);
    }
    if (record.type === "JOURNAL_RECOVERED") droppedEventCount += numeric(record.payload.droppedFragments);
    const expectedPayloadHash = sha256(canonicalJson(record.payload));
    if (record.payloadSha256 !== expectedPayloadHash) hashMismatches.push(record.sequence);
    const expectedEventHash = sha256(canonicalJson(unsignedRecord(record)));
    if (record.eventHash !== expectedEventHash) hashMismatches.push(record.sequence);
    if (!verifyDigest(record.eventHash, record.sourceSignature, publicKeyPem)) signatureFailures.push(record.sequence);
  }

  const undeclaredGaps = gaps.filter((gap) => !gap.declared);
  if (undeclaredGaps.length) errors.push("Journal contains undeclared sequence gaps.");
  if (duplicateSequences.length) errors.push("Journal contains duplicate sequences.");
  if (duplicateRecordIds.length) errors.push("Journal contains duplicate record identifiers.");
  if (hashMismatches.length) errors.push("Journal hash chain does not reconcile.");
  if (signatureFailures.length) errors.push("Journal contains invalid source signatures.");
  const complete = records[0]?.type === "RUN_STARTED" && records.at(-1)?.type === "RUN_COMPLETED";
  return {
    valid: errors.length === 0,
    complete,
    sourceSigned: records.length > 0 && signatureFailures.length === 0,
    gaps,
    duplicateSequences: [...new Set(duplicateSequences)],
    duplicateRecordIds: [...new Set(duplicateRecordIds)],
    hashMismatches: [...new Set(hashMismatches)],
    signatureFailures: [...new Set(signatureFailures)],
    droppedEventCount,
    recoveredTailBytes,
    errors,
  };
}

function unsignedRecord(record: TrustedActionRecord): Omit<TrustedActionRecord, "eventHash" | "sourceSignature"> {
  const { eventHash: _eventHash, sourceSignature: _sourceSignature, ...unsigned } = record;
  return unsigned;
}

async function recoverJournal(filePath: string): Promise<{ records: TrustedActionRecord[]; recoveredTailBytes: number }> {
  let raw = "";
  try { raw = await readFile(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!raw) return { records: [], recoveredTailBytes: 0 };
  const lines = raw.split("\n");
  const records: TrustedActionRecord[] = [];
  let recoveredTailBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as TrustedActionRecord); }
    catch {
      const isTail = lines.slice(index + 1).every((candidate) => !candidate.trim());
      if (!isTail) throw new Error(`Trusted recorder journal contains invalid JSON at line ${index + 1}.`);
      recoveredTailBytes = Buffer.byteLength(line);
      await writeFile(filePath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
      break;
    }
  }
  return { records, recoveredTailBytes };
}

async function readAck(filePath: string, records: TrustedActionRecord[]): Promise<number> {
  let raw = "";
  try { raw = await readFile(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return -1; throw error; }
  let ack: RecorderAck;
  try { ack = JSON.parse(raw) as RecorderAck; }
  catch { throw new Error("Recorder acknowledgement file is invalid JSON."); }
  const record = records.find((item) => item.sequence === ack.sequence);
  if (!record || record.eventHash !== ack.eventHash) throw new Error("Recorder acknowledgement does not match the journal.");
  return ack.sequence;
}

async function appendDurably(filePath: string, value: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a");
  try { await handle.write(value); await handle.sync(); }
  finally { await handle.close(); }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Recorder ${field} is required.`);
  return value;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
