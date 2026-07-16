import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOnegentRuntime, type OnegentRuntime } from "./sdk.js";
import type {
  ActionAuditPacket,
  ActionExecutionReceipt,
  ActionExecutionSummary,
  CreateActionIntentInput,
  LocalActionAdapter,
  PolicyRule,
  VerificationResult,
} from "./types.js";

export const SANDBOX_CERTIFICATION_SCHEMA_VERSION = "agentcert.sandbox_certification.v0.1" as const;
export const SANDBOX_RUN_SCHEMA_VERSION = "agentcert.sandbox_run.v0.1" as const;

export type SandboxSeed = Record<string, Record<string, unknown>>;

export interface SandboxTenantInput {
  id: string;
  synthetic: true;
  displayName?: string;
  seed?: SandboxSeed;
  ttlMs?: number;
}

export interface SandboxTenantLease {
  tenantId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SandboxSystemSafety {
  readonly mode: "sandbox";
  readonly networkAccess: false;
  readonly syntheticDataOnly: true;
  readonly allowedTargetSystems: readonly string[];
}

export interface SandboxSystem {
  name: string;
  safety: SandboxSystemSafety;
  createTenant(input: SandboxTenantInput): void | Promise<void>;
  deleteTenant(tenantId: string): void | Promise<void>;
  resetTenant(tenantId: string): void | Promise<void>;
  seedTenant(tenantId: string, seed: SandboxSeed): void | Promise<void>;
  hasTenant(tenantId: string): boolean | Promise<boolean>;
  snapshotTenant(tenantId: string): SandboxSeed | Promise<SandboxSeed>;
  adapterForTenant(tenantId: string): LocalActionAdapter;
}

export interface InMemorySandboxSystemOptions {
  name?: string;
  allowedTargetSystems: string[];
}

export interface SandboxExecutionLimits {
  readonly maxActionsPerRun: number;
  readonly maxAmountPerAction: number;
  readonly maxTotalAmountPerRun: number;
}

export interface SandboxKillSwitchState {
  enabled: boolean;
  reason?: string;
  changedAt: string;
}

export type SandboxRejectionCode =
  | "ACTION_LIMIT_EXCEEDED"
  | "AMOUNT_LIMIT_EXCEEDED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_REQUIRED"
  | "GLOBAL_KILL_SWITCH"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_REQUIRED"
  | "INVALID_AMOUNT"
  | "NETWORK_DENIED"
  | "PRODUCTION_DENIED"
  | "RUN_AMOUNT_LIMIT_EXCEEDED"
  | "TARGET_NOT_ALLOWED"
  | "TENANT_KILL_SWITCH"
  | "TENANT_MISMATCH";

export interface SandboxApprovalDecision {
  approved: boolean;
  reviewerId: string;
  comment?: string;
}

export interface SandboxActionOptions {
  approval?: SandboxApprovalDecision;
  rollbackAfterVerification?: boolean;
  rollbackReason?: string;
}

export type SandboxActionStatus = "verified" | "rolled_back" | "rejected" | "failed" | "rollback_failed";

export interface SandboxActionResult {
  idempotencyKey: string;
  actionIntentId?: string;
  status: SandboxActionStatus;
  rejectionCode?: SandboxRejectionCode;
  message: string;
  startedAt: string;
  completedAt: string;
  execution?: ActionExecutionSummary;
  verification?: VerificationResult;
  rollback?: ActionExecutionReceipt;
  auditPacket?: ActionAuditPacket;
}

export interface SandboxRunSummary {
  attempted: number;
  verified: number;
  rolledBack: number;
  rejected: number;
  failed: number;
  totalApprovedAmount: number;
}

export interface SandboxRunReport {
  schemaVersion: typeof SANDBOX_RUN_SCHEMA_VERSION;
  kind: "agentcert.sandbox_run";
  runId: string;
  tenantId: string;
  system: string;
  startedAt: string;
  completedAt: string;
  safe: boolean;
  syntheticData: true;
  networkAccess: false;
  allowedTargetSystems: string[];
  limits: SandboxExecutionLimits;
  summary: SandboxRunSummary;
  actions: SandboxActionResult[];
  disclaimer: string;
}

export interface SandboxRun {
  readonly runId: string;
  readonly tenantId: string;
  executeAction(input: CreateActionIntentInput, options?: SandboxActionOptions): Promise<SandboxActionResult>;
  complete(): SandboxRunReport;
}

export interface SandboxHarnessOptions {
  system?: SandboxSystem;
  allowedTargetSystems?: string[];
  limits?: Partial<SandboxExecutionLimits>;
  tenantTtlMs?: number;
  maxTenantTtlMs?: number;
  cleanupIntervalMs?: number;
  autoCleanup?: boolean;
  now?: () => Date;
}

export interface SandboxCertificationHarness {
  readonly limits: SandboxExecutionLimits;
  createTenant(input: SandboxTenantInput): Promise<SandboxTenantLease>;
  deleteTenant(tenantId: string): Promise<void>;
  tenantLease(tenantId: string): SandboxTenantLease | undefined;
  renewTenant(tenantId: string, ttlMs?: number): Promise<SandboxTenantLease>;
  cleanupExpiredTenants(): Promise<string[]>;
  seedTenant(tenantId: string, seed: SandboxSeed): Promise<void>;
  resetTenant(tenantId: string): Promise<void>;
  snapshotTenant(tenantId: string): Promise<SandboxSeed>;
  startRun(input: { tenantId: string; runId?: string }): Promise<SandboxRun>;
  setGlobalKillSwitch(enabled: boolean, reason?: string): SandboxKillSwitchState;
  setTenantKillSwitch(tenantId: string, enabled: boolean, reason?: string): SandboxKillSwitchState;
  close(): Promise<void>;
}

export interface SandboxCertificationCheck {
  id: string;
  status: "passed" | "failed";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface SandboxCertificationReport {
  schemaVersion: typeof SANDBOX_CERTIFICATION_SCHEMA_VERSION;
  kind: "agentcert.sandbox_certification";
  implementation: string;
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: SandboxCertificationCheck[];
  runIds: string[];
  disclaimer: string;
}

export interface SandboxCertificationSuiteOptions {
  system?: SandboxSystem;
  implementation?: string;
  targetSystem?: string;
  now?: () => Date;
}

const DEFAULT_LIMITS: SandboxExecutionLimits = {
  maxActionsPerRun: 25,
  maxAmountPerAction: 10_000,
  maxTotalAmountPerRun: 25_000,
};

const DEFAULT_TENANT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_TENANT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1_000;

const REQUIRE_SANDBOX_APPROVAL: PolicyRule = {
  id: "sandbox-all-actions-require-approval",
  name: "All sandbox writes require approval",
  description: "The certification harness requires an identified reviewer before any synthetic state mutation.",
  actionTypes: ["SUBMIT", "PAY", "SEND", "UPDATE"],
  effect: "REQUIRE_APPROVAL",
  enabled: true,
};

class SandboxRejectedError extends Error {
  constructor(readonly code: SandboxRejectionCode, message: string) {
    super(message);
  }
}

// Low-level synthetic state lifecycle. Policy, approval, and limits remain in the harness.
export function createInMemorySandboxSystem(options: InMemorySandboxSystemOptions): SandboxSystem {
  const allowedTargetSystems = Object.freeze(normalizedTargets(options.allowedTargetSystems));
  const tenants = new Map<string, { seed: SandboxSeed; state: SandboxSeed }>();

  const tenant = (tenantId: string) => {
    const value = tenants.get(tenantId);
    if (!value) throw new Error(`Sandbox tenant ${tenantId} was not found.`);
    return value;
  };

  return {
    name: options.name ?? "agentcert-in-memory-sandbox",
    safety: {
      mode: "sandbox",
      networkAccess: false,
      syntheticDataOnly: true,
      allowedTargetSystems,
    },
    createTenant: (input) => {
      assertTenantId(input.id);
      if (input.synthetic !== true) throw new Error("Sandbox tenants must explicitly declare synthetic: true.");
      if (tenants.has(input.id)) throw new Error(`Sandbox tenant ${input.id} already exists.`);
      const seed = validatedSeed(input.seed ?? {});
      tenants.set(input.id, { seed, state: structuredClone(seed) });
    },
    deleteTenant: (tenantId) => {
      if (!tenants.delete(tenantId)) throw new Error(`Sandbox tenant ${tenantId} was not found.`);
    },
    resetTenant: (tenantId) => {
      const value = tenant(tenantId);
      value.state = structuredClone(value.seed);
    },
    seedTenant: (tenantId, input) => {
      const value = tenant(tenantId);
      const seed = validatedSeed(input);
      value.seed = seed;
      value.state = structuredClone(seed);
    },
    hasTenant: (tenantId) => tenants.has(tenantId),
    snapshotTenant: (tenantId) => structuredClone(tenant(tenantId).state),
    adapterForTenant: (tenantId) => {
      tenant(tenantId);
      const assertAction = (action: Parameters<LocalActionAdapter["execute"]>[0]) => {
        if (action.workspaceId !== tenantId) {
          throw new SandboxRejectedError("TENANT_MISMATCH", `Action workspace ${action.workspaceId} cannot access tenant ${tenantId}.`);
        }
        if (action.environment === "production") {
          throw new SandboxRejectedError("PRODUCTION_DENIED", "The sandbox system refuses production actions.");
        }
        if (action.targetUrl) {
          throw new SandboxRejectedError("NETWORK_DENIED", "The sandbox system denies network targets by default.");
        }
        if (!allowedTargetSystems.includes(action.targetSystem)) {
          throw new SandboxRejectedError("TARGET_NOT_ALLOWED", `Target system ${action.targetSystem} is not allowlisted.`);
        }
      };
      return {
        name: `${options.name ?? "agentcert-in-memory-sandbox"}:${tenantId}`,
        safety: { mode: "sandbox", networkAccess: false, allowedTargetSystems: [...allowedTargetSystems] },
        execute: (action) => {
          assertAction(action);
          const value = tenant(tenantId);
          const previousState = structuredClone(value.state[action.businessObjectId] ?? action.beforeState);
          const observedState = structuredClone(action.proposedAfterState);
          value.state[action.businessObjectId] = observedState;
          return {
            method: "LOCAL_ADAPTER",
            targetSystem: action.targetSystem,
            previousState,
            observedState,
            rollbackToken: `${tenantId}:${action.idempotencyKey}`,
          };
        },
        rollback: (action, execution) => {
          assertAction(action);
          const restored = structuredClone(execution.previousState ?? action.beforeState);
          tenant(tenantId).state[action.businessObjectId] = restored;
          return { success: true, observedState: restored, message: "Tenant sandbox state restored to its pre-execution snapshot." };
        },
      };
    },
  };
}

// The harness is the only supported execution path for bounded sandbox runs.
export function createSandboxCertificationHarness(options: SandboxHarnessOptions): SandboxCertificationHarness {
  const system = options.system ?? createInMemorySandboxSystem({
    allowedTargetSystems: options.allowedTargetSystems ?? [],
  });
  assertSandboxSystem(system);
  const allowedTargetSystems = Object.freeze(normalizedTargets([...system.safety.allowedTargetSystems]));
  const limits = Object.freeze(normalizeLimits(options.limits));
  const now = options.now ?? (() => new Date());
  const maxTenantTtlMs = positiveInteger(options.maxTenantTtlMs ?? DEFAULT_MAX_TENANT_TTL_MS, "maxTenantTtlMs");
  const tenantTtlMs = boundedTenantTtl(options.tenantTtlMs ?? DEFAULT_TENANT_TTL_MS, maxTenantTtlMs);
  const cleanupIntervalMs = positiveInteger(options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS, "cleanupIntervalMs");
  const runtime = createOnegentRuntime({
    policyRules: [REQUIRE_SANDBOX_APPROVAL],
    authorizationPolicy: {
      name: "sandbox-tenant-authorization",
      authorize: (action) => ({
        allowed: allowedTargetSystems.includes(action.targetSystem),
        grantedPermissions: allowedTargetSystems.includes(action.targetSystem) ? [...action.requestedPermissions] : [],
        policyVersion: "agentcert.sandbox.v0.1",
        reason: allowedTargetSystems.includes(action.targetSystem)
          ? "The target is within the sandbox allowlist."
          : "The target is outside the sandbox allowlist.",
      }),
    },
  });
  const runs = new Set<string>();
  const tenantSwitches = new Map<string, SandboxKillSwitchState>();
  const tenantLeases = new Map<string, SandboxTenantLease>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupInFlight: Promise<string[]> | undefined;
  let closed = false;
  let globalSwitch: SandboxKillSwitchState = { enabled: false, changedAt: now().toISOString() };

  const assertOpen = () => {
    if (closed) throw new Error("Sandbox certification harness is closed.");
  };
  const removeTenant = async (tenantId: string) => {
    if (await system.hasTenant(tenantId)) await system.deleteTenant(tenantId);
    tenantLeases.delete(tenantId);
    tenantSwitches.delete(tenantId);
  };
  const cleanupExpiredTenants = (): Promise<string[]> => {
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = (async () => {
      const cutoff = now().getTime();
      const expired = [...tenantLeases.values()]
        .filter((lease) => Date.parse(lease.expiresAt) <= cutoff)
        .map((lease) => lease.tenantId);
      const removed: string[] = [];
      for (const tenantId of expired) {
        await removeTenant(tenantId);
        removed.push(tenantId);
      }
      return removed;
    })().finally(() => { cleanupInFlight = undefined; });
    return cleanupInFlight;
  };
  const assertActiveTenant = async (tenantId: string) => {
    const lease = tenantLeases.get(tenantId);
    if (lease && Date.parse(lease.expiresAt) <= now().getTime()) await cleanupExpiredTenants();
    if (!tenantLeases.has(tenantId) || !(await system.hasTenant(tenantId))) {
      throw new Error(`Sandbox tenant ${tenantId} was not found or its lease expired.`);
    }
  };
  if (options.autoCleanup !== false) {
    cleanupTimer = setInterval(() => { void cleanupExpiredTenants().catch(() => undefined); }, cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  return {
    limits,
    createTenant: async (input) => {
      assertOpen();
      const effectiveTtlMs = boundedTenantTtl(input.ttlMs ?? tenantTtlMs, maxTenantTtlMs);
      await system.createTenant(input);
      const createdAt = now();
      const lease = {
        tenantId: input.id,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + effectiveTtlMs).toISOString(),
      };
      tenantLeases.set(input.id, lease);
      return { ...lease };
    },
    deleteTenant: async (tenantId) => {
      assertOpen();
      if (!tenantLeases.has(tenantId) && !(await system.hasTenant(tenantId))) {
        throw new Error(`Sandbox tenant ${tenantId} was not found.`);
      }
      await removeTenant(tenantId);
    },
    tenantLease: (tenantId) => {
      const lease = tenantLeases.get(tenantId);
      return lease ? { ...lease } : undefined;
    },
    renewTenant: async (tenantId, ttlMs) => {
      assertOpen();
      await assertActiveTenant(tenantId);
      const effectiveTtlMs = boundedTenantTtl(ttlMs ?? tenantTtlMs, maxTenantTtlMs);
      const previous = tenantLeases.get(tenantId)!;
      const lease = { ...previous, expiresAt: new Date(now().getTime() + effectiveTtlMs).toISOString() };
      tenantLeases.set(tenantId, lease);
      return { ...lease };
    },
    cleanupExpiredTenants,
    seedTenant: async (tenantId, seed) => { assertOpen(); await assertActiveTenant(tenantId); await system.seedTenant(tenantId, seed); },
    resetTenant: async (tenantId) => { assertOpen(); await assertActiveTenant(tenantId); await system.resetTenant(tenantId); },
    snapshotTenant: async (tenantId) => { assertOpen(); await assertActiveTenant(tenantId); return system.snapshotTenant(tenantId); },
    startRun: async ({ tenantId, runId }) => {
      assertOpen();
      await assertActiveTenant(tenantId);
      const effectiveRunId = runId?.trim() || `sandbox-run-${randomUUID()}`;
      if (runs.has(effectiveRunId)) throw new Error(`Sandbox run ${effectiveRunId} already exists.`);
      runs.add(effectiveRunId);
      return createSandboxRun({
        runId: effectiveRunId,
        tenantId,
        system,
        allowedTargetSystems,
        runtime,
        limits,
        now,
        globalSwitch: () => globalSwitch,
        tenantSwitch: () => tenantSwitches.get(tenantId),
      });
    },
    setGlobalKillSwitch: (enabled, reason) => {
      globalSwitch = killSwitch(enabled, reason, now);
      return { ...globalSwitch };
    },
    setTenantKillSwitch: (tenantId, enabled, reason) => {
      const next = killSwitch(enabled, reason, now);
      tenantSwitches.set(tenantId, next);
      return { ...next };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      await cleanupInFlight?.catch(() => undefined);
      for (const tenantId of [...tenantLeases.keys()]) await removeTenant(tenantId);
    },
  };
}

interface SandboxRunInternalOptions {
  runId: string;
  tenantId: string;
  system: SandboxSystem;
  allowedTargetSystems: readonly string[];
  runtime: OnegentRuntime;
  limits: SandboxExecutionLimits;
  now: () => Date;
  globalSwitch: () => SandboxKillSwitchState;
  tenantSwitch: () => SandboxKillSwitchState | undefined;
}

function createSandboxRun(options: SandboxRunInternalOptions): SandboxRun {
  const startedAt = options.now().toISOString();
  const results: SandboxActionResult[] = [];
  const idempotency = new Map<string, { fingerprint: string; promise: Promise<SandboxActionResult> }>();
  let attempted = 0;
  let totalApprovedAmount = 0;
  let completed = false;

  const executeNew = async (
    input: CreateActionIntentInput,
    actionOptions: SandboxActionOptions,
    idempotencyKey: string,
  ): Promise<SandboxActionResult> => {
    const actionStartedAt = options.now().toISOString();
    attempted += 1;
    let actionIntentId: string | undefined;
    try {
      assertRunPreflight({
        input,
        tenantId: options.tenantId,
        system: options.system,
        allowedTargetSystems: options.allowedTargetSystems,
        limits: options.limits,
        attempted,
        totalApprovedAmount,
        globalSwitch: options.globalSwitch(),
        tenantSwitch: options.tenantSwitch(),
        approval: actionOptions.approval,
      });

      const amount = input.amount ?? 0;
      const review = options.runtime.captureAction({
        ...input,
        idempotencyKey,
        workspaceId: options.tenantId,
        workflowId: input.workflowId ?? options.runId,
        sourceAgentRunId: input.sourceAgentRunId ?? options.runId,
        environment: input.environment ?? "demo",
      });
      actionIntentId = review.action.id;
      const approval = actionOptions.approval!;
      if (!approval.approved) {
        options.runtime.rejectAction(review.action, approval.reviewerId, approval.comment ?? "Rejected during sandbox certification.");
        const packet = await options.runtime.writeAuditPacket(review.action);
        return recordResult({
          idempotencyKey,
          actionIntentId,
          status: "rejected",
          rejectionCode: "APPROVAL_REJECTED",
          message: "The identified reviewer rejected the sandbox action.",
          startedAt: actionStartedAt,
          completedAt: options.now().toISOString(),
          auditPacket: packet,
        });
      }

      options.runtime.approveAction(review.action, approval.reviewerId, approval.comment ?? "Approved for sandbox certification.");
      totalApprovedAmount += amount;
      const adapter = options.system.adapterForTenant(options.tenantId);
      const execution = await options.runtime.executeAfterApproval(review.action, adapter);
      const verification = options.runtime.verifyOutcome(review.action, execution);
      let rollback: ActionExecutionReceipt | undefined;
      let status: SandboxActionStatus = verification.success ? "verified" : "failed";
      let message = verification.success ? "Sandbox execution matched the expected synthetic state." : "Sandbox verification detected a state mismatch.";

      if (actionOptions.rollbackAfterVerification) {
        rollback = await options.runtime.rollbackAfterExecution(
          review.action,
          adapter,
          actionOptions.rollbackReason ?? "Sandbox certification rollback requested.",
        );
        status = rollback.status === "ROLLED_BACK" ? "rolled_back" : "rollback_failed";
        message = rollback.status === "ROLLED_BACK"
          ? "Sandbox execution verified and the pre-execution state was restored."
          : "Sandbox rollback failed after verification.";
      }

      const packet = await options.runtime.writeAuditPacket(review.action);
      return recordResult({
        idempotencyKey,
        actionIntentId,
        status,
        message,
        startedAt: actionStartedAt,
        completedAt: options.now().toISOString(),
        execution,
        verification,
        rollback,
        auditPacket: packet,
      });
    } catch (error) {
      if (error instanceof SandboxRejectedError) {
        return recordResult(rejectedResult(idempotencyKey, actionStartedAt, options.now, error.code, error.message, actionIntentId));
      }
      return recordResult({
        idempotencyKey,
        actionIntentId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        startedAt: actionStartedAt,
        completedAt: options.now().toISOString(),
      });
    }
  };

  const recordResult = (result: SandboxActionResult) => {
    results.push(result);
    return result;
  };

  return {
    runId: options.runId,
    tenantId: options.tenantId,
    executeAction: async (input, actionOptions = {}) => {
      if (completed) throw new Error(`Sandbox run ${options.runId} is already complete.`);
      const idempotencyKey = input.idempotencyKey?.trim();
      if (!idempotencyKey) {
        attempted += 1;
        return recordResult(rejectedResult(
          "missing",
          options.now().toISOString(),
          options.now,
          "IDEMPOTENCY_REQUIRED",
          "Sandbox actions require an explicit idempotency key.",
        ));
      }
      const fingerprint = sha256(canonicalJson({ input: { ...input, idempotencyKey }, options: actionOptions }));
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint === fingerprint) return existing.promise;
        attempted += 1;
        return recordResult(rejectedResult(
          idempotencyKey,
          options.now().toISOString(),
          options.now,
          "IDEMPOTENCY_CONFLICT",
          `Idempotency key ${idempotencyKey} was reused with different sandbox action content.`,
        ));
      }
      const promise = executeNew(input, actionOptions, idempotencyKey);
      idempotency.set(idempotencyKey, { fingerprint, promise });
      return promise;
    },
    complete: () => {
      if (completed) throw new Error(`Sandbox run ${options.runId} is already complete.`);
      completed = true;
      const summary: SandboxRunSummary = {
        attempted,
        verified: results.filter((item) => item.status === "verified").length,
        rolledBack: results.filter((item) => item.status === "rolled_back").length,
        rejected: results.filter((item) => item.status === "rejected").length,
        failed: results.filter((item) => item.status === "failed" || item.status === "rollback_failed").length,
        totalApprovedAmount,
      };
      return {
        schemaVersion: SANDBOX_RUN_SCHEMA_VERSION,
        kind: "agentcert.sandbox_run",
        runId: options.runId,
        tenantId: options.tenantId,
        system: options.system.name,
        startedAt,
        completedAt: options.now().toISOString(),
        safe: summary.failed === 0,
        syntheticData: true,
        networkAccess: false,
        allowedTargetSystems: [...options.allowedTargetSystems],
        limits: { ...options.limits },
        summary,
        actions: structuredClone(results),
        disclaimer: "Synthetic sandbox evidence only. This report does not authorize production writes or prove a live integration is safe.",
      };
    },
  };
}

// Actively exercises the safety contract instead of inferring compliance from configuration.
export async function runSandboxCertificationSuite(
  options: SandboxCertificationSuiteOptions = {},
): Promise<SandboxCertificationReport> {
  const now = options.now ?? (() => new Date());
  const targetSystem = options.targetSystem ?? options.system?.safety.allowedTargetSystems[0] ?? "SandboxCRM";
  const system = options.system ?? createInMemorySandboxSystem({ allowedTargetSystems: [targetSystem] });
  const harness = createSandboxCertificationHarness({
    system,
    limits: { maxActionsPerRun: 1, maxAmountPerAction: 5_000, maxTotalAmountPerRun: 5_000 },
    now,
  });
  const suffix = randomUUID().slice(0, 8);
  const unlistedTarget = `AgentCertUnlisted-${suffix}`;
  const tenantA = `cert-a-${suffix}`;
  const tenantB = `cert-b-${suffix}`;
  const checks: SandboxCertificationCheck[] = [];
  const runIds: string[] = [];
  const seed = { "account-1": { tier: "standard", owner: "Synthetic Customer" } };
  try {
    await harness.createTenant({ id: tenantA, synthetic: true, seed });
    await harness.createTenant({ id: tenantB, synthetic: true, seed: { "account-1": { tier: "restricted" } } });
  } catch (error) {
    await harness.close();
    throw error;
  }

  const check = async (id: string, message: string, operation: () => Promise<Record<string, unknown> | void>) => {
    try {
      const evidence = await operation();
      checks.push({ id, status: "passed", message, ...(evidence ? { evidence } : {}) });
    } catch (error) {
      checks.push({ id, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  await check("tenant-isolation", "Cross-tenant action context is rejected before state access.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "tenant-isolation");
    const result = await run.executeAction(referenceAction(targetSystem, { workspaceId: tenantB }));
    expectRejection(result, "TENANT_MISMATCH");
    return { rejectionCode: result.rejectionCode };
  });
  await check("synthetic-data-only", "Credential-like seed data is rejected.", async () => {
    let rejected = false;
    try {
      await harness.createTenant({ id: `secret-${suffix}`, synthetic: true, seed: { record: { apiKey: "sk-proj-not-allowed-in-sandbox-fixture" } } });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Credential-like seed data was accepted.");
  });
  await check("deny-network-egress", "Network targets are denied by default.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "network");
    const result = await run.executeAction(referenceAction(targetSystem, { targetUrl: "https://example.invalid/write" }));
    expectRejection(result, "NETWORK_DENIED");
    return { rejectionCode: result.rejectionCode };
  });
  await check("target-allowlist", "Non-allowlisted target systems are rejected.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "target");
    const result = await run.executeAction(referenceAction(unlistedTarget));
    expectRejection(result, "TARGET_NOT_ALLOWED");
    return { rejectionCode: result.rejectionCode };
  });
  await check("production-deny", "Production actions are rejected.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "production");
    const result = await run.executeAction(referenceAction(targetSystem, { environment: "production" }));
    expectRejection(result, "PRODUCTION_DENIED");
    return { rejectionCode: result.rejectionCode };
  });
  await check("approval-gate", "An identified human approval is required before mutation.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "approval");
    const result = await run.executeAction(referenceAction(targetSystem));
    expectRejection(result, "APPROVAL_REQUIRED");
    return { rejectionCode: result.rejectionCode };
  });
  await check("execution-limits", "Per-action amount and per-run action limits fail closed.", async () => {
    const amountRun = await certificationRun(harness, tenantA, runIds, "amount-limit");
    const amount = await amountRun.executeAction(referenceAction(targetSystem, { amount: 5_001 }), approved());
    expectRejection(amount, "AMOUNT_LIMIT_EXCEEDED");
    const actionRun = await certificationRun(harness, tenantA, runIds, "action-limit");
    await actionRun.executeAction(referenceAction(targetSystem, { idempotencyKey: `first-${suffix}` }), approved());
    const second = await actionRun.executeAction(referenceAction(targetSystem, { idempotencyKey: `second-${suffix}` }), approved());
    expectRejection(second, "ACTION_LIMIT_EXCEEDED");
    return { amount: amount.rejectionCode, action: second.rejectionCode };
  });
  await check("kill-switches", "Tenant and global kill switches stop new execution.", async () => {
    harness.setTenantKillSwitch(tenantA, true, "Certification tenant stop.");
    const tenantRun = await certificationRun(harness, tenantA, runIds, "tenant-kill");
    const tenantResult = await tenantRun.executeAction(referenceAction(targetSystem), approved());
    expectRejection(tenantResult, "TENANT_KILL_SWITCH");
    harness.setTenantKillSwitch(tenantA, false);
    harness.setGlobalKillSwitch(true, "Certification global stop.");
    const globalRun = await certificationRun(harness, tenantA, runIds, "global-kill");
    const globalResult = await globalRun.executeAction(referenceAction(targetSystem), approved());
    expectRejection(globalResult, "GLOBAL_KILL_SWITCH");
    harness.setGlobalKillSwitch(false);
    return { tenant: tenantResult.rejectionCode, global: globalResult.rejectionCode };
  });
  await check("idempotent-execution", "Concurrent identical retries share one sandbox action result.", async () => {
    const run = await certificationRun(harness, tenantA, runIds, "idempotency");
    const input = referenceAction(targetSystem, { idempotencyKey: `concurrent-${suffix}` });
    const [first, second] = await Promise.all([run.executeAction(input, approved()), run.executeAction(input, approved())]);
    if (!first.actionIntentId || first.actionIntentId !== second.actionIntentId) throw new Error("Concurrent retries did not share one action intent.");
    const report = run.complete();
    if (report.actions.length !== 1) throw new Error(`Expected one recorded action, observed ${report.actions.length}.`);
    return { actionIntentId: first.actionIntentId };
  });
  await check("verification-rollback-reset", "Expected state is verified, rollback restores the snapshot, and reset restores the seed.", async () => {
    await harness.resetTenant(tenantA);
    const run = await certificationRun(harness, tenantA, runIds, "rollback");
    const result = await run.executeAction(referenceAction(targetSystem, { idempotencyKey: `rollback-${suffix}` }), {
      ...approved(),
      rollbackAfterVerification: true,
    });
    if (result.status !== "rolled_back" || !result.verification?.success) throw new Error("Verified execution did not roll back successfully.");
    const afterRollback = await harness.snapshotTenant(tenantA);
    if (canonicalJson(afterRollback) !== canonicalJson(seed)) throw new Error("Rollback did not restore the tenant seed state.");

    const mutateRun = await certificationRun(harness, tenantA, runIds, "reset");
    const mutation = await mutateRun.executeAction(referenceAction(targetSystem, { idempotencyKey: `reset-${suffix}` }), approved());
    if (mutation.status !== "verified") throw new Error("Reference mutation did not verify.");
    await harness.resetTenant(tenantA);
    const afterReset = await harness.snapshotTenant(tenantA);
    if (canonicalJson(afterReset) !== canonicalJson(seed)) throw new Error("Reset did not restore the tenant seed state.");
    return { rollback: result.status, reset: "restored" };
  });

  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.length - passed;
  const report: SandboxCertificationReport = {
    schemaVersion: SANDBOX_CERTIFICATION_SCHEMA_VERSION,
    kind: "agentcert.sandbox_certification",
    implementation: options.implementation ?? system.name,
    generatedAt: now().toISOString(),
    verdict: { passed: failed === 0, score: Math.round((passed / checks.length) * 100) },
    summary: { passed, failed, total: checks.length },
    checks,
    runIds,
    disclaimer: "This certification covers the synthetic sandbox contract only. It does not certify production systems, credentials, payments, email delivery, or vendor portals.",
  };
  await harness.close();
  return report;
}

export async function writeSandboxReport(report: SandboxRunReport | SandboxCertificationReport, filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(absolutePath, 0o600);
  return absolutePath;
}

function assertRunPreflight(input: {
  input: CreateActionIntentInput;
  tenantId: string;
  system: SandboxSystem;
  allowedTargetSystems: readonly string[];
  limits: SandboxExecutionLimits;
  attempted: number;
  totalApprovedAmount: number;
  globalSwitch: SandboxKillSwitchState;
  tenantSwitch?: SandboxKillSwitchState;
  approval?: SandboxApprovalDecision;
}): void {
  if (input.globalSwitch.enabled) throw new SandboxRejectedError("GLOBAL_KILL_SWITCH", input.globalSwitch.reason ?? "The global sandbox kill switch is enabled.");
  if (input.tenantSwitch?.enabled) throw new SandboxRejectedError("TENANT_KILL_SWITCH", input.tenantSwitch.reason ?? "The tenant sandbox kill switch is enabled.");
  if (input.input.workspaceId && input.input.workspaceId !== input.tenantId) {
    throw new SandboxRejectedError("TENANT_MISMATCH", `Action workspace ${input.input.workspaceId} does not match tenant ${input.tenantId}.`);
  }
  if (input.input.environment === "production") throw new SandboxRejectedError("PRODUCTION_DENIED", "Production actions are not allowed in the certification sandbox.");
  if (input.input.targetUrl) throw new SandboxRejectedError("NETWORK_DENIED", "Network targets are denied by default in Sandbox Certification Harness v0.1.");
  if (!input.allowedTargetSystems.includes(input.input.targetSystem)) {
    throw new SandboxRejectedError("TARGET_NOT_ALLOWED", `Target system ${input.input.targetSystem} is not allowlisted.`);
  }
  if (input.attempted > input.limits.maxActionsPerRun) {
    throw new SandboxRejectedError("ACTION_LIMIT_EXCEEDED", `Run action limit ${input.limits.maxActionsPerRun} was exceeded.`);
  }
  const amount = input.input.amount ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new SandboxRejectedError("INVALID_AMOUNT", "Action amount must be a finite non-negative number.");
  if (amount > input.limits.maxAmountPerAction) {
    throw new SandboxRejectedError("AMOUNT_LIMIT_EXCEEDED", `Action amount ${amount} exceeds the sandbox limit ${input.limits.maxAmountPerAction}.`);
  }
  if (input.totalApprovedAmount + amount > input.limits.maxTotalAmountPerRun) {
    throw new SandboxRejectedError("RUN_AMOUNT_LIMIT_EXCEEDED", `Run amount would exceed the sandbox limit ${input.limits.maxTotalAmountPerRun}.`);
  }
  if (!input.approval) throw new SandboxRejectedError("APPROVAL_REQUIRED", "An explicit sandbox approval decision is required before execution.");
  if (!input.approval.reviewerId?.trim()) throw new SandboxRejectedError("APPROVAL_REQUIRED", "The sandbox approval decision must identify the reviewer.");
}

function rejectedResult(
  idempotencyKey: string,
  startedAt: string,
  now: () => Date,
  rejectionCode: SandboxRejectionCode,
  message: string,
  actionIntentId?: string,
): SandboxActionResult {
  return { idempotencyKey, actionIntentId, status: "rejected", rejectionCode, message, startedAt, completedAt: now().toISOString() };
}

function normalizeLimits(input: Partial<SandboxExecutionLimits> | undefined): SandboxExecutionLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || (name === "maxActionsPerRun" && !Number.isInteger(value))) {
      throw new Error(`Sandbox limit ${name} must be a positive${name === "maxActionsPerRun" ? " integer" : " number"}.`);
    }
  }
  return limits;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Sandbox ${name} must be a positive integer.`);
  return value;
}

function boundedTenantTtl(value: number, maxTenantTtlMs: number): number {
  const ttlMs = positiveInteger(value, "tenant ttlMs");
  if (ttlMs > maxTenantTtlMs) throw new Error(`Sandbox tenant ttlMs cannot exceed ${maxTenantTtlMs}.`);
  return ttlMs;
}

function normalizedTargets(input: readonly string[]): string[] {
  const targets = [...new Set(input.map((item) => item.trim()).filter(Boolean))];
  if (targets.length === 0) throw new Error("Sandbox systems require at least one allowed target system.");
  return targets;
}

function assertSandboxSystem(system: SandboxSystem): void {
  if (system.safety.mode !== "sandbox" || system.safety.networkAccess !== false || system.safety.syntheticDataOnly !== true) {
    throw new Error("Sandbox Certification Harness v0.1 accepts only synthetic, network-denied sandbox systems.");
  }
  normalizedTargets(system.safety.allowedTargetSystems);
}

function assertTenantId(tenantId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantId)) {
    throw new Error("Sandbox tenant IDs must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.");
  }
}

function validatedSeed(input: SandboxSeed): SandboxSeed {
  assertSyntheticValue(input, "seed", new Set<object>());
  return structuredClone(input);
}

export function validateSyntheticSandboxSeed(input: SandboxSeed): SandboxSeed {
  return validatedSeed(input);
}

function assertSyntheticValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (/^(?:sk-(?:proj-)?|npm_|gh[pousr]_)[A-Za-z0-9_-]{16,}$/.test(value)) {
      throw new Error(`Credential-like value is not allowed in synthetic sandbox data at ${path}.`);
    }
    return;
  }
  if (typeof value !== "object") throw new Error(`Synthetic sandbox data must be JSON-compatible at ${path}.`);
  if (seen.has(value)) throw new Error(`Synthetic sandbox data cannot contain cycles at ${path}.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSyntheticValue(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/(?:password|passwd|secret|token|api[_-]?key|credential|authorization|cookie)/i.test(key)) {
        throw new Error(`Credential-like field ${path}.${key} is not allowed in synthetic sandbox data.`);
      }
      assertSyntheticValue(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function killSwitch(enabled: boolean, reason: string | undefined, now: () => Date): SandboxKillSwitchState {
  return { enabled, reason: reason?.trim() || undefined, changedAt: now().toISOString() };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function referenceAction(targetSystem: string, overrides: Partial<CreateActionIntentInput> = {}): CreateActionIntentInput {
  return {
    idempotencyKey: `cert-action-${randomUUID()}`,
    sourceAgentName: "SandboxCertificationAgent",
    actionType: "UPDATE",
    targetSystem,
    environment: "demo",
    title: "Update synthetic account tier",
    description: "Exercise the isolated AgentCert reference sandbox.",
    businessObjectType: "account",
    businessObjectId: "account-1",
    amount: 100,
    currency: "USD",
    beforeState: { tier: "standard", owner: "Synthetic Customer" },
    proposedAfterState: { tier: "enterprise", owner: "Synthetic Customer" },
    fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
    ...overrides,
  };
}

function approved(): SandboxActionOptions {
  return { approval: { approved: true, reviewerId: "sandbox-certifier@agentcert.local", comment: "Approved for deterministic certification." } };
}

async function certificationRun(
  harness: SandboxCertificationHarness,
  tenantId: string,
  runIds: string[],
  label: string,
): Promise<SandboxRun> {
  const runId = `cert-${label}-${randomUUID().slice(0, 8)}`;
  runIds.push(runId);
  return harness.startRun({ tenantId, runId });
}

function expectRejection(result: SandboxActionResult, code: SandboxRejectionCode): void {
  if (result.status !== "rejected" || result.rejectionCode !== code) {
    throw new Error(`Expected ${code}, observed ${result.status}/${result.rejectionCode ?? "none"}.`);
  }
}
