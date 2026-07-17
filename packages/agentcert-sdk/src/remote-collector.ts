import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export interface CustomerSourceSigner {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

interface StoredCustomerSourceKey extends CustomerSourceSigner {
  createdAt: string;
  status: "active" | "retired";
  retiredAt?: string;
}

interface StoredCustomerKeyRing {
  schemaVersion: "agentcert.customer_source_keyring.v0.2";
  collectorId: string;
  activeKeyId: string;
  keys: StoredCustomerSourceKey[];
}

export interface RemoteTrustedSourceRecord {
  schemaVersion: "agentcert.trusted_action_record.v0.1";
  recordId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  collector: { id: string; version: string; environment: string; keyId: string; publicKeySha256: string };
  previousEventHash?: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  eventHash: string;
  sourceSignature: { algorithm: "Ed25519"; keyId: string; signature: string };
}

export interface RemoteCollectorAck {
  schemaVersion: "agentcert.remote_collector_ack.v0.2";
  accepted: number;
  replayed: number;
  ack: { sequence: number; eventHash: string };
  alerts: Array<Record<string, unknown>>;
  run: Record<string, unknown>;
}

export interface RemoteCollectorClientOptions {
  baseUrl: string;
  projectId: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class CustomerSourceKeyRing {
  private constructor(readonly filePath: string, private value: StoredCustomerKeyRing) {}

  static async create(filePath: string, collectorId: string, keyId = `${collectorId}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`): Promise<CustomerSourceKeyRing> {
    identifier(collectorId, "collectorId");
    identifier(keyId, "keyId");
    const target = resolve(filePath);
    try { await readFile(target); throw new Error(`Customer source key ring already exists at ${target}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const key = generatedKey(keyId, new Date().toISOString());
    const ring = new CustomerSourceKeyRing(target, { schemaVersion: "agentcert.customer_source_keyring.v0.2", collectorId, activeKeyId: keyId, keys: [key] });
    await ring.persist();
    return ring;
  }

  static async open(filePath: string): Promise<CustomerSourceKeyRing> {
    const target = resolve(filePath);
    const parsed = JSON.parse(await readFile(target, "utf8")) as StoredCustomerKeyRing;
    validateRing(parsed);
    return new CustomerSourceKeyRing(target, parsed);
  }

  get collectorId(): string { return this.value.collectorId; }

  activeSigner(): CustomerSourceSigner {
    const key = this.value.keys.find((item) => item.keyId === this.value.activeKeyId && item.status === "active");
    if (!key) throw new Error("Customer source key ring has no active signing key.");
    return { keyId: key.keyId, privateKeyPem: key.privateKeyPem, publicKeyPem: key.publicKeyPem };
  }

  signerFor(keyId: string): CustomerSourceSigner {
    const key = this.value.keys.find((item) => item.keyId === keyId);
    if (!key) throw new Error(`Customer source key ${keyId} is not present in this key ring.`);
    return { keyId: key.keyId, privateKeyPem: key.privateKeyPem, publicKeyPem: key.publicKeyPem };
  }

  registration(previousKeyId?: string): { collectorId: string; keyId: string; publicKeyPem: string; previousKeyId?: string } {
    const signer = this.activeSigner();
    const previous = previousKeyId ?? [...this.value.keys].reverse().find((item) => item.status === "retired")?.keyId;
    return { collectorId: this.collectorId, keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, previousKeyId: previous };
  }

  async rotate(keyId = `${this.collectorId}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`): Promise<{ previousKeyId: string; signer: CustomerSourceSigner }> {
    identifier(keyId, "keyId");
    if (this.value.keys.some((item) => item.keyId === keyId)) throw new Error(`Customer source key ${keyId} already exists.`);
    const now = new Date().toISOString();
    const previousKeyId = this.value.activeKeyId;
    this.value = {
      ...this.value,
      activeKeyId: keyId,
      keys: [...this.value.keys.map((item) => item.keyId === previousKeyId ? { ...item, status: "retired" as const, retiredAt: now } : item), generatedKey(keyId, now)],
    };
    await this.persist();
    return { previousKeyId, signer: this.activeSigner() };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
  }
}

export class RemoteCollectorClient {
  readonly baseUrl: string;
  readonly projectId: string;
  private readonly apiKey: string;
  private readonly requestFetch: typeof fetch;

  constructor(options: RemoteCollectorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.projectId = options.projectId;
    this.apiKey = options.apiKey;
    this.requestFetch = options.fetch ?? fetch;
    if (!this.baseUrl || !this.projectId || !this.apiKey) throw new Error("baseUrl, projectId, and apiKey are required.");
  }

  registerSourceKey(input: { collectorId: string; keyId: string; publicKeyPem: string; previousKeyId?: string }): Promise<Record<string, unknown>> {
    return this.json("collector-keys", { method: "POST", body: JSON.stringify(input) });
  }

  append(runId: string, records: RemoteTrustedSourceRecord[], idempotencyKey = `record-${records[0]?.eventHash ?? randomUUID()}`): Promise<RemoteCollectorAck> {
    return this.json<RemoteCollectorAck>(`trusted-runs/${encodeURIComponent(runId)}/records`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ records }),
    });
  }

  heartbeat(input: { collectorId: string; signer: CustomerSourceSigner; runId?: string; pendingRecordCount: number; lastAckSequence?: number; occurredAt?: string }): Promise<Record<string, unknown>> {
    const payload = {
      schemaVersion: "agentcert.collector_heartbeat.v0.2" as const,
      collectorId: input.collectorId,
      sourceKeyId: input.signer.keyId,
      runId: input.runId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      pendingRecordCount: input.pendingRecordCount,
      lastAckSequence: input.lastAckSequence,
    };
    const payloadSha256 = sha256(canonicalJson(payload));
    return this.json("collector-heartbeats", {
      method: "POST",
      body: JSON.stringify({ payload, payloadSha256, signature: signSourceDigest(payloadSha256, input.signer) }),
    });
  }

  reconcile(runId: string, receipt: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json(`trusted-runs/${encodeURIComponent(runId)}/reconcile`, {
      method: "POST",
      headers: { "idempotency-key": `reconcile-${String(receipt.receiptSha256 ?? randomUUID())}` },
      body: JSON.stringify(receipt),
    });
  }

  status(): Promise<Record<string, unknown>> { return this.json("collector-status"); }

  async revokeSourceKey(keyId: string): Promise<Record<string, unknown>> {
    return this.json(`collector-keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  }

  sink(): { name: string; write(record: RemoteTrustedSourceRecord): Promise<void> } {
    return {
      name: "agentcert-remote-collector-v0.2",
      write: async (record) => { await this.append(record.runId, [record], `record-${record.eventHash}`); },
    };
  }

  private async json<T = Record<string, unknown>>(suffix: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestFetch(`${this.baseUrl}/v1/projects/${encodeURIComponent(this.projectId)}/${suffix}`, {
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new RemoteCollectorApiError(response.status, String(body.code ?? "remote_collector_error"), String(body.error ?? `AgentCert API request failed (${response.status}).`), typeof body.recovery === "string" ? body.recovery : undefined);
    return body as T;
  }
}

export class DurableRemoteCollectorQueue {
  readonly journalPath: string;
  readonly ackPath: string;
  private replayChain: Promise<void> = Promise.resolve();

  constructor(directory: string, readonly runId: string) {
    this.journalPath = resolve(directory, `${safeFileName(runId)}.remote.jsonl`);
    this.ackPath = resolve(directory, `${safeFileName(runId)}.remote-ack.json`);
  }

  async enqueue(record: RemoteTrustedSourceRecord): Promise<void> {
    if (record.runId !== this.runId) throw new Error("Queued record runId does not match the durable queue runId.");
    await mkdir(dirname(this.journalPath), { recursive: true });
    const handle = await open(this.journalPath, "a");
    try { await handle.write(`${JSON.stringify(record)}\n`); await handle.sync(); }
    finally { await handle.close(); }
  }

  async pending(): Promise<RemoteTrustedSourceRecord[]> {
    const records = await this.all();
    const ack = await this.readAck();
    validateAck(records, ack);
    return records.filter((record) => record.sequence > ack.sequence);
  }

  async all(): Promise<RemoteTrustedSourceRecord[]> {
    let raw = "";
    try { raw = await readFile(this.journalPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as RemoteTrustedSourceRecord; }
      catch { throw new Error(`Remote collector queue contains invalid JSON at line ${index + 1}.`); }
    });
  }

  async currentAck(): Promise<{ sequence: number; eventHash?: string }> {
    const records = await this.all();
    const ack = await this.readAck();
    validateAck(records, ack);
    return ack;
  }

  async replay(client: { append(runId: string, records: RemoteTrustedSourceRecord[], idempotencyKey?: string): Promise<RemoteCollectorAck> }): Promise<{ delivered: number; ack?: { sequence: number; eventHash: string } }> {
    let result: { delivered: number; ack?: { sequence: number; eventHash: string } } | undefined;
    const operation = this.replayChain.then(async () => {
      let delivered = 0;
      let latest: { sequence: number; eventHash: string } | undefined;
      for (const record of await this.pending()) {
        const response = await client.append(record.runId, [record], `record-${record.eventHash}`);
        latest = response.ack;
        await this.writeAck(latest);
        delivered += 1;
      }
      result = { delivered, ack: latest };
    });
    this.replayChain = operation.catch(() => undefined);
    await operation;
    return result!;
  }

  private async readAck(): Promise<{ sequence: number; eventHash?: string }> {
    try {
      const value = JSON.parse(await readFile(this.ackPath, "utf8")) as { sequence?: unknown; eventHash?: unknown };
      if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/.test(value.eventHash)) {
        throw new Error("Remote collector ACK file is invalid.");
      }
      return { sequence: Number(value.sequence), eventHash: value.eventHash };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sequence: -1 }; throw error; }
  }

  private async writeAck(ack: { sequence: number; eventHash: string }): Promise<void> {
    const records = await this.all();
    validateAck(records, ack);
    const current = await this.readAck();
    if (current.sequence > ack.sequence) return;
    if (current.sequence === ack.sequence) {
      if (current.eventHash !== ack.eventHash) throw new Error(`Remote collector ACK hash conflicts at sequence ${ack.sequence}.`);
      return;
    }
    await mkdir(dirname(this.ackPath), { recursive: true });
    const temporary = `${this.ackPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(ack), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.ackPath);
  }
}

function validateAck(records: RemoteTrustedSourceRecord[], ack: { sequence: number; eventHash?: string }): void {
  if (ack.sequence === -1) return;
  const acknowledged = records.find((record) => record.sequence === ack.sequence);
  if (!acknowledged || acknowledged.eventHash !== ack.eventHash) {
    throw new Error(`Remote collector ACK does not match the local journal at sequence ${ack.sequence}.`);
  }
}

export class RemoteCollectorApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly recovery?: string) {
    super(message);
    this.name = "RemoteCollectorApiError";
  }
}

function generatedKey(keyId: string, createdAt: string): StoredCustomerSourceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    createdAt,
    status: "active",
  };
}

function signSourceDigest(digest: string, signer: CustomerSourceSigner): { algorithm: "Ed25519"; keyId: string; signature: string } {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("A SHA-256 digest is required for source signing.");
  return { algorithm: "Ed25519", keyId: signer.keyId, signature: sign(null, Buffer.from(digest, "hex"), createPrivateKey(signer.privateKeyPem)).toString("base64url") };
}

function validateRing(value: StoredCustomerKeyRing): void {
  if (value.schemaVersion !== "agentcert.customer_source_keyring.v0.2") throw new Error("Customer source key ring schemaVersion is not supported.");
  identifier(value.collectorId, "collectorId");
  identifier(value.activeKeyId, "activeKeyId");
  if (!Array.isArray(value.keys) || value.keys.length === 0) throw new Error("Customer source key ring has no keys.");
  for (const key of value.keys) {
    identifier(key.keyId, "keys[].keyId");
    const privateKey = createPrivateKey(key.privateKeyPem);
    const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    if (privateKey.asymmetricKeyType !== "ed25519" || derivedPublic !== createPublicKey(key.publicKeyPem).export({ type: "spki", format: "pem" }).toString()) {
      throw new Error(`Customer source key ${key.keyId} is invalid.`);
    }
  }
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function identifier(value: string, field: string): string {
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error(`${field} must use 1 to 160 URL-safe identifier characters.`);
  return value;
}
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160); }
