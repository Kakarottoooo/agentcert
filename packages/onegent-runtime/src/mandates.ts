import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ActionIntent, CreateActionIntentInput } from "./types.js";
import type {
  ActionMandate,
  ActionMandatePayload,
  CreateActionMandateInput,
  MandateStore,
  MandateVerification,
  SourceSigner,
} from "./trust-types.js";
import { canonicalJson, sha256, signDigest, verifyDigest } from "./trust-crypto.js";

export function issueActionMandate(input: CreateActionMandateInput, signer: SourceSigner): ActionMandate {
  const payload: ActionMandatePayload = {
    schemaVersion: "agentcert.action_mandate.v0.1",
    mandateId: required(input.mandateId, "mandateId"),
    issuer: structuredClone(input.issuer),
    subject: structuredClone(input.subject),
    scope: structuredClone(input.scope),
    expectedOutcome: input.expectedOutcome ? structuredClone(input.expectedOutcome) : undefined,
    policySha256: input.policySha256,
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  validateMandatePayload(payload);
  const digestSha256 = sha256(canonicalJson(payload));
  return deepFreeze({ ...payload, digestSha256, sourceSignature: signDigest(digestSha256, signer) });
}

export function verifyActionMandate(mandate: ActionMandate, publicKeyPem: string, at = new Date()): MandateVerification {
  const errors: string[] = [];
  let payloadValid = true;
  try { validateMandatePayload(mandate); }
  catch (error) { payloadValid = false; errors.push(message(error)); }
  const payload = mandatePayload(mandate);
  const actualDigest = sha256(canonicalJson(payload));
  const digestMatches = actualDigest === mandate.digestSha256;
  if (!digestMatches) errors.push("Mandate digest does not match its immutable payload.");
  const signatureMatches = mandate.sourceSignature.keyId.length > 0
    && verifyDigest(mandate.digestSha256, mandate.sourceSignature, publicKeyPem);
  if (!signatureMatches) errors.push("Mandate source signature is invalid.");
  const timestamp = at.getTime();
  const active = Number.isFinite(timestamp)
    && timestamp >= Date.parse(mandate.validFrom)
    && timestamp < Date.parse(mandate.expiresAt);
  if (!active) errors.push("Mandate is not active at the requested action time.");
  return { valid: payloadValid && digestMatches && signatureMatches && active, digestMatches, signatureMatches, active, errors };
}

export function assertMandateAuthorizesAction(
  mandate: ActionMandate,
  action: CreateActionIntentInput | ActionIntent,
): void {
  if (action.mandateId && action.mandateId !== mandate.mandateId) throw new Error("Action references a different mandate.");
  if (action.principal?.id !== mandate.subject.principalId) throw new Error("Action principal is not the mandate subject.");
  if (mandate.subject.agentVersion && action.principal?.version !== mandate.subject.agentVersion) {
    throw new Error("Action agent version does not match the mandate subject version.");
  }
  if (!mandate.scope.actionTypes.includes(action.actionType)) throw new Error(`Mandate does not allow ${action.actionType} actions.`);
  if (!mandate.scope.targetSystems.includes(action.targetSystem)) throw new Error(`Mandate does not allow target system ${action.targetSystem}.`);
  const permissions = action.requestedPermissions ?? [`${action.targetSystem}:${action.actionType}`];
  const missingPermissions = permissions.filter((permission) => !mandate.scope.permissions.includes(permission));
  if (missingPermissions.length) throw new Error(`Mandate does not grant permissions: ${missingPermissions.join(", ")}.`);
  if (mandate.scope.businessObjectIds?.length && !mandate.scope.businessObjectIds.includes(action.businessObjectId)) {
    throw new Error(`Mandate does not allow business object ${action.businessObjectId}.`);
  }
  if (mandate.scope.recipients?.length && (!action.recipient || !mandate.scope.recipients.includes(action.recipient))) {
    throw new Error(`Mandate does not allow recipient ${action.recipient ?? "<missing>"}.`);
  }
  if (mandate.scope.currencies?.length && (!action.currency || !mandate.scope.currencies.includes(action.currency))) {
    throw new Error(`Mandate does not allow currency ${action.currency ?? "<missing>"}.`);
  }
  if (mandate.scope.maxAmount !== undefined && (action.amount === undefined || action.amount > mandate.scope.maxAmount)) {
    throw new Error(`Action amount exceeds mandate maximum ${mandate.scope.maxAmount}.`);
  }
  if (mandate.expectedOutcome && canonicalJson(action.proposedAfterState ?? {}) !== canonicalJson(mandate.expectedOutcome)) {
    throw new Error("Action expected outcome does not match the immutable mandate outcome.");
  }
}

export class FileMandateStore implements MandateStore {
  readonly name = "agentcert-file-mandate-store";
  private readonly mandates = new Map<string, ActionMandate>();

  private constructor(readonly filePath: string) {}

  static async open(filePath: string): Promise<FileMandateStore> {
    const store = new FileMandateStore(resolve(filePath));
    await mkdir(dirname(store.filePath), { recursive: true });
    let raw = "";
    try { raw = await readFile(store.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let mandate: ActionMandate;
      try { mandate = JSON.parse(line) as ActionMandate; }
      catch { throw new Error(`Mandate store contains invalid JSON at line ${index + 1}.`); }
      const existing = store.mandates.get(mandate.mandateId);
      if (existing && existing.digestSha256 !== mandate.digestSha256) throw new Error(`Mandate ${mandate.mandateId} was mutated in the append-only store.`);
      store.mandates.set(mandate.mandateId, deepFreeze(structuredClone(mandate)));
    }
    return store;
  }

  async get(mandateId: string): Promise<ActionMandate | undefined> {
    const mandate = this.mandates.get(mandateId);
    return mandate ? deepFreeze(structuredClone(mandate)) : undefined;
  }

  async put(mandate: ActionMandate): Promise<ActionMandate> {
    const existing = this.mandates.get(mandate.mandateId);
    if (existing) {
      if (existing.digestSha256 !== mandate.digestSha256) throw new Error(`Mandate ${mandate.mandateId} is immutable and cannot be replaced.`);
      return deepFreeze(structuredClone(existing));
    }
    const frozen = deepFreeze(structuredClone(mandate));
    const handle = await open(this.filePath, "a");
    try {
      await handle.write(`${JSON.stringify(frozen)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    this.mandates.set(frozen.mandateId, frozen);
    return deepFreeze(structuredClone(frozen));
  }

  async list(): Promise<ActionMandate[]> {
    return [...this.mandates.values()].map((mandate) => deepFreeze(structuredClone(mandate)));
  }
}

function mandatePayload(mandate: ActionMandate): ActionMandatePayload {
  return {
    schemaVersion: mandate.schemaVersion,
    mandateId: mandate.mandateId,
    issuer: mandate.issuer,
    subject: mandate.subject,
    scope: mandate.scope,
    expectedOutcome: mandate.expectedOutcome,
    policySha256: mandate.policySha256,
    validFrom: mandate.validFrom,
    expiresAt: mandate.expiresAt,
    issuedAt: mandate.issuedAt,
  };
}

function validateMandatePayload(payload: ActionMandatePayload): void {
  required(payload.mandateId, "mandateId");
  required(payload.issuer?.id, "issuer.id");
  required(payload.subject?.principalId, "subject.principalId");
  if (!/^[a-f0-9]{64}$/.test(payload.policySha256)) throw new Error("policySha256 must be a SHA-256 hex digest.");
  if (!payload.scope?.actionTypes.length || !payload.scope.targetSystems.length || !payload.scope.permissions.length) {
    throw new Error("Mandate action types, target systems, and permissions cannot be empty.");
  }
  const timestamps = [payload.validFrom, payload.expiresAt, payload.issuedAt].map(Date.parse);
  if (timestamps.some((value) => !Number.isFinite(value))) throw new Error("Mandate timestamps must be valid ISO date-times.");
  if (timestamps[1] <= timestamps[0]) throw new Error("Mandate expiresAt must be after validFrom.");
  if (payload.scope.maxAmount !== undefined && (!Number.isFinite(payload.scope.maxAmount) || payload.scope.maxAmount < 0)) {
    throw new Error("Mandate maxAmount must be a non-negative finite number.");
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Mandate ${field} is required.`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
