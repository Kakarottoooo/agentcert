import { createHash, createPublicKey, sign, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "./canonical.js";
import {
  CustomerSourceKeyRing,
  DurableRemoteCollectorQueue,
  type CustomerSourceSigner,
  type RemoteCollectorAck,
  type RemoteTrustedSourceRecord,
} from "./remote-collector.js";

export interface RemoteCollectorTransport {
  registerSourceKey(input: { collectorId: string; keyId: string; publicKeyPem: string; previousKeyId?: string }): Promise<Record<string, unknown>>;
  append(runId: string, records: RemoteTrustedSourceRecord[], idempotencyKey?: string): Promise<RemoteCollectorAck>;
  heartbeat(input: { collectorId: string; signer: CustomerSourceSigner; pendingRecordCount: number; lastAckSequence?: number }): Promise<Record<string, unknown>>;
  reconcile(runId: string, receipt: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CustomerOwnedCollectorGatewayOptions {
  client: RemoteCollectorTransport;
  keyRing: CustomerSourceKeyRing;
  gatewayToken: string;
  storageDirectory: string;
  collectorVersion?: string;
  environment?: string;
  host?: string;
  port?: number;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxBodyBytes?: number;
}

export interface CustomerOwnedCollectorGateway {
  baseUrl: string;
  close(): Promise<void>;
  flush(): Promise<{ delivered: number; reconciled: number; pending: number }>;
  status(): Promise<CollectorGatewayStatus>;
}

export interface CollectorGatewayStatus {
  schemaVersion: "agentcert.customer_collector_gateway_status.v0.2";
  collectorId: string;
  sourceKeyId: string;
  runCount: number;
  pendingRecordCount: number;
  lastAckSequence?: number;
  lastRemoteSuccessAt?: string;
  lastRemoteError?: string;
}

interface CompleteInput {
  payload?: Record<string, unknown>;
  mandateDigests?: string[];
  actionIds?: string[];
  evidenceStrength?: Record<string, unknown>;
  idempotencyKey?: string;
}

export async function startCustomerOwnedCollectorGateway(options: CustomerOwnedCollectorGatewayOptions): Promise<CustomerOwnedCollectorGateway> {
  if (options.gatewayToken.length < 24) throw new Error("gatewayToken must contain at least 24 characters.");
  const storageDirectory = resolve(options.storageDirectory);
  await mkdir(storageDirectory, { recursive: true });
  const signer = options.keyRing.activeSigner();
  let sourceKeyRegistered = false;
  const journals = new Map<string, GatewayRunJournal>();
  const activeCollector = {
    id: options.keyRing.collectorId,
    version: options.collectorVersion ?? "0.2.0",
    environment: options.environment ?? "customer-owned",
    keyId: signer.keyId,
    publicKeySha256: publicKeyFingerprint(signer.publicKeyPem),
  };
  let lastRemoteSuccessAt: string | undefined;
  let lastRemoteError: string | undefined;

  const ensureSourceKeyRegistered = async (): Promise<void> => {
    if (sourceKeyRegistered) return;
    await options.client.registerSourceKey(options.keyRing.registration());
    sourceKeyRegistered = true;
  };

  const journalFor = async (runId: string): Promise<GatewayRunJournal> => {
    identifier(runId, "runId");
    const existing = journals.get(runId);
    if (existing) return existing;
    const queue = new DurableRemoteCollectorQueue(storageDirectory, runId);
    const first = (await queue.all())[0];
    const runSigner = first ? options.keyRing.signerFor(first.collector.keyId) : signer;
    const journal = await GatewayRunJournal.open(storageDirectory, runId, first?.collector ?? activeCollector, runSigner);
    journals.set(runId, journal);
    return journal;
  };

  const flush = async () => {
    let delivered = 0;
    let reconciled = 0;
    let pending = 0;
    try { await ensureSourceKeyRegistered(); }
    catch (error) { lastRemoteError = message(error); }
    for (const journal of journals.values()) {
      try {
        if (!sourceKeyRegistered) throw new Error(lastRemoteError ?? "Collector source key is not registered.");
        delivered += (await journal.queue.replay(options.client)).delivered;
        if (await journal.reconcileIfReady(options.client)) reconciled += 1;
        lastRemoteSuccessAt = new Date().toISOString();
        lastRemoteError = undefined;
      } catch (error) {
        lastRemoteError = message(error);
      }
      pending += (await journal.queue.pending()).length;
    }
    return { delivered, reconciled, pending };
  };

  const status = async (): Promise<CollectorGatewayStatus> => {
    let pendingRecordCount = 0;
    let lastAckSequence: number | undefined;
    for (const journal of journals.values()) {
      pendingRecordCount += (await journal.queue.pending()).length;
      const ack = await journal.queue.currentAck();
      if (ack.sequence >= 0) lastAckSequence = Math.max(lastAckSequence ?? -1, ack.sequence);
    }
    return {
      schemaVersion: "agentcert.customer_collector_gateway_status.v0.2",
      collectorId: activeCollector.id,
      sourceKeyId: activeCollector.keyId,
      runCount: journals.size,
      pendingRecordCount,
      lastAckSequence,
      lastRemoteSuccessAt,
      lastRemoteError,
    };
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, await status());
      authenticate(request, options.gatewayToken);
      if (request.method === "POST" && url.pathname === "/v1/flush") return json(response, 200, await flush());
      const route = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/(start|events|drops|complete)$/);
      if (!route) return json(response, 404, { error: "not found" });
      const runId = route[1];
      const operation = route[2];
      const body = await readJson(request, options.maxBodyBytes ?? 1_048_576);
      const journal = await journalFor(runId);
      let record: RemoteTrustedSourceRecord;
      if (operation === "start") {
        record = await journal.append("RUN_STARTED", object(body.payload), String(body.idempotencyKey ?? "run-start"));
      } else if (operation === "events") {
        record = await journal.append(identifier(body.type, "type"), object(body.payload), identifier(body.idempotencyKey, "idempotencyKey"));
      } else if (operation === "drops") {
        const count = positiveInteger(body.count, "count");
        record = await journal.append("EVENTS_DROPPED", { count, reason: required(body.reason, "reason") }, identifier(body.idempotencyKey, "idempotencyKey"), count);
      } else {
        const input = body as CompleteInput;
        record = await journal.append("RUN_COMPLETED", object(input.payload), String(input.idempotencyKey ?? "run-complete"));
        await journal.writeReceipt({
          mandateDigests: strings(input.mandateDigests),
          actionIds: strings(input.actionIds),
          evidenceStrength: object(input.evidenceStrength),
        });
      }
      const remote = await flush();
      return json(response, 202, { durable: true, record, remote });
    } catch (error) {
      const statusCode = error instanceof GatewayRequestError ? error.status : 500;
      return json(response, statusCode, { error: message(error) });
    }
  });

  await listen(server, options.port ?? 0, options.host ?? "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector gateway did not bind a TCP port.");
  const flushTimer = setInterval(() => void flush(), options.flushIntervalMs ?? 5_000);
  const heartbeatTimer = setInterval(async () => {
    const current = await status();
    try {
      await ensureSourceKeyRegistered();
      await options.client.heartbeat({
        collectorId: activeCollector.id,
        signer,
        pendingRecordCount: current.pendingRecordCount,
        lastAckSequence: current.lastAckSequence,
      });
      lastRemoteSuccessAt = new Date().toISOString();
      lastRemoteError = undefined;
    } catch (error) { lastRemoteError = message(error); }
  }, options.heartbeatIntervalMs ?? 30_000);
  flushTimer.unref();
  heartbeatTimer.unref();

  for (const runId of await discoverRunIds(storageDirectory)) await journalFor(runId);
  await flush();

  return {
    baseUrl: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    close: async () => {
      clearInterval(flushTimer);
      clearInterval(heartbeatTimer);
      await flush();
      await close(server);
    },
    flush,
    status,
  };
}

class GatewayRunJournal {
  readonly queue: DurableRemoteCollectorQueue;
  private records: RemoteTrustedSourceRecord[];
  private chain: Promise<void> = Promise.resolve();
  private readonly receiptPath: string;
  private readonly reconciliationPath: string;

  private constructor(
    directory: string,
    readonly runId: string,
    private readonly collector: RemoteTrustedSourceRecord["collector"],
    private readonly signer: CustomerSourceSigner,
    records: RemoteTrustedSourceRecord[],
  ) {
    this.queue = new DurableRemoteCollectorQueue(directory, runId);
    this.records = records;
    const base = safeFileName(runId);
    this.receiptPath = join(resolve(directory), `${base}.receipt.json`);
    this.reconciliationPath = join(resolve(directory), `${base}.reconciled.json`);
  }

  static async open(directory: string, runId: string, collector: RemoteTrustedSourceRecord["collector"], signer: CustomerSourceSigner): Promise<GatewayRunJournal> {
    const queue = new DurableRemoteCollectorQueue(directory, runId);
    const records = await queue.all();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.runId !== runId || canonicalJson(record.collector) !== canonicalJson(collector)) throw new Error(`Stored gateway journal for ${runId} has a different collector identity.`);
      if (index > 0 && record.previousEventHash !== records[index - 1].eventHash) throw new Error(`Stored gateway journal for ${runId} has a broken hash chain.`);
    }
    return new GatewayRunJournal(directory, runId, collector, signer, records);
  }

  async append(type: string, payload: Record<string, unknown>, idempotencyKey: string, skippedSequences = 0): Promise<RemoteTrustedSourceRecord> {
    identifier(idempotencyKey, "idempotencyKey");
    let result: RemoteTrustedSourceRecord | undefined;
    const operation = this.chain.then(async () => {
      const recordId = sha256(`${this.runId}:${idempotencyKey}`);
      const replay = this.records.find((record) => record.recordId === recordId);
      if (replay) {
        if (replay.type !== type || canonicalJson(replay.payload) !== canonicalJson(payload)) throw new GatewayRequestError(409, `idempotencyKey ${idempotencyKey} was already used with different content.`);
        result = replay;
        return;
      }
      if (this.records.at(-1)?.type === "RUN_COMPLETED") throw new GatewayRequestError(409, `Run ${this.runId} is already complete.`);
      if (this.records.length === 0 && type !== "RUN_STARTED") throw new GatewayRequestError(409, `Run ${this.runId} must start before appending records.`);
      const previous = this.records.at(-1);
      const occurredAt = new Date().toISOString();
      const payloadSha256 = sha256(canonicalJson(payload));
      const unsigned = {
        schemaVersion: "agentcert.trusted_action_record.v0.1" as const,
        recordId,
        runId: this.runId,
        sequence: (previous?.sequence ?? -1) + 1 + skippedSequences,
        occurredAt,
        type,
        collector: this.collector,
        previousEventHash: previous?.eventHash,
        payload,
        payloadSha256,
      };
      const eventHash = sha256(canonicalJson(unsigned));
      result = { ...unsigned, eventHash, sourceSignature: signDigest(eventHash, this.signer) };
      await this.queue.enqueue(result);
      this.records.push(result);
    });
    this.chain = operation.catch(() => undefined);
    await operation;
    return structuredClone(result!);
  }

  async writeReceipt(input: { mandateDigests: string[]; actionIds: string[]; evidenceStrength: Record<string, unknown> }): Promise<void> {
    const first = this.records[0];
    const last = this.records.at(-1);
    if (!first || last?.type !== "RUN_COMPLETED") throw new Error("A completed run is required before writing a receipt.");
    const droppedEventCount = this.records.filter((record) => record.type === "EVENTS_DROPPED")
      .reduce((total, record) => total + Number(record.payload.count ?? 0), 0);
    const payload = {
      schemaVersion: "agentcert.trusted_run_receipt.v0.1",
      runId: this.runId,
      collector: this.collector,
      startedAt: first.occurredAt,
      completedAt: last.occurredAt,
      eventCount: this.records.length,
      droppedEventCount,
      firstEventHash: first.eventHash,
      lastEventHash: last.eventHash,
      mandateDigests: [...new Set(input.mandateDigests)].sort(),
      actionIds: [...new Set(input.actionIds)].sort(),
      journal: { valid: true, complete: true, sourceSigned: true, gaps: [], duplicateSequences: [], duplicateRecordIds: [], hashMismatches: [], signatureFailures: [], droppedEventCount, recoveredTailBytes: 0, errors: [] },
      evidenceStrength: input.evidenceStrength,
      sourcePublicKeyPem: this.signer.publicKeyPem,
    };
    const receiptSha256 = sha256(canonicalJson(payload));
    await writeFile(this.receiptPath, `${JSON.stringify({ ...payload, receiptSha256, sourceSignature: signDigest(receiptSha256, this.signer) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async reconcileIfReady(client: RemoteCollectorTransport): Promise<boolean> {
    if ((await this.queue.pending()).length > 0) return false;
    try { await readFile(this.reconciliationPath, "utf8"); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(await readFile(this.receiptPath, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const reconciliation = await client.reconcile(this.runId, receipt);
    await writeFile(this.reconciliationPath, `${JSON.stringify(reconciliation)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  }
}

class GatewayRequestError extends Error {
  constructor(readonly status: number, messageText: string) { super(messageText); }
}

function authenticate(request: IncomingMessage, expected: string): void {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new GatewayRequestError(401, "Gateway authentication failed.");
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new GatewayRequestError(413, `Request body exceeds ${maxBytes} bytes.`);
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; }
  catch { throw new GatewayRequestError(400, "Request body must be valid JSON."); }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => server.once("error", reject).listen(port, host, resolvePromise));
}
function close(server: Server): Promise<void> { return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); }
function json(response: ServerResponse, status: number, body: unknown): void { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function publicKeyFingerprint(publicKeyPem: string): string { return sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })); }
function signDigest(digest: string, signer: CustomerSourceSigner) {
  return { algorithm: "Ed25519" as const, keyId: signer.keyId, signature: sign(null, Buffer.from(digest, "hex"), signer.privateKeyPem).toString("base64url") };
}
function identifier(value: unknown, field: string): string { const parsed = required(value, field); if (parsed.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(parsed)) throw new GatewayRequestError(400, `${field} must use URL-safe identifier characters.`); return parsed; }
function required(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new GatewayRequestError(400, `${field} is required.`); return value; }
function object(value: unknown): Record<string, unknown> { if (value === undefined) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayRequestError(400, "Expected a JSON object."); return value as Record<string, unknown>; }
function strings(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new GatewayRequestError(400, "Expected an array of strings."); return value as string[]; }
function positiveInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new GatewayRequestError(400, `${field} must be a positive integer.`); return value; }
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function discoverRunIds(directory: string): Promise<string[]> {
  const runIds = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".remote.jsonl")) continue;
    const firstLine = (await readFile(join(directory, entry.name), "utf8")).split(/\r?\n/, 1)[0];
    if (!firstLine) continue;
    const record = JSON.parse(firstLine) as RemoteTrustedSourceRecord;
    runIds.add(identifier(record.runId, "stored runId"));
  }
  return [...runIds];
}
