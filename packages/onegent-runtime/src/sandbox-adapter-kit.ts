import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSandboxCertificationHarness,
  runSandboxCertificationSuite,
  validateSyntheticSandboxSeed,
  type SandboxCertificationCheck,
  type SandboxCertificationReport,
  type SandboxSeed,
  type SandboxSystem,
  type SandboxTenantInput,
} from "./sandbox-harness.js";
import type { LocalActionAdapter } from "./types.js";

export const SANDBOX_ADAPTER_CONFORMANCE_SCHEMA_VERSION = "agentcert.sandbox_adapter_conformance.v0.2" as const;

export interface SandboxSystemAdapterHandlers {
  createTenant(input: SandboxTenantInput): void | Promise<void>;
  deleteTenant(tenantId: string): void | Promise<void>;
  resetTenant(tenantId: string): void | Promise<void>;
  seedTenant(tenantId: string, seed: SandboxSeed): void | Promise<void>;
  hasTenant(tenantId: string): boolean | Promise<boolean>;
  snapshotTenant(tenantId: string): SandboxSeed | Promise<SandboxSeed>;
  adapterForTenant(tenantId: string): LocalActionAdapter;
}

export interface SandboxSystemAdapterDefinition {
  name: string;
  allowedTargetSystems: string[];
  handlers: SandboxSystemAdapterHandlers;
}

export interface SandboxAdapterConformanceReport {
  schemaVersion: typeof SANDBOX_ADAPTER_CONFORMANCE_SCHEMA_VERSION;
  kind: "agentcert.sandbox_adapter_conformance";
  implementation: string;
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: SandboxCertificationCheck[];
  certification?: SandboxCertificationReport;
  disclaimer: string;
}

export interface SandboxAdapterConformanceOptions {
  system: SandboxSystem;
  implementation?: string;
  targetSystem?: string;
  now?: () => Date;
}

export function createSandboxSystemAdapter(definition: SandboxSystemAdapterDefinition): SandboxSystem {
  const name = definition.name.trim();
  if (!name) throw new Error("Sandbox adapter name is required.");
  const allowedTargetSystems = normalizeTargets(definition.allowedTargetSystems);
  const handlers = definition.handlers;
  for (const method of ["createTenant", "deleteTenant", "resetTenant", "seedTenant", "hasTenant", "snapshotTenant", "adapterForTenant"] as const) {
    if (typeof handlers[method] !== "function") throw new Error(`Sandbox adapter handler ${method} is required.`);
  }
  return {
    name,
    safety: Object.freeze({
      mode: "sandbox" as const,
      networkAccess: false as const,
      syntheticDataOnly: true as const,
      allowedTargetSystems: Object.freeze(allowedTargetSystems),
    }),
    createTenant: (input) => {
      if (input.synthetic !== true) throw new Error("Sandbox adapter tenants must declare synthetic: true.");
      return handlers.createTenant({
        ...input,
        ...(input.seed ? { seed: validateSyntheticSandboxSeed(input.seed) } : {}),
      });
    },
    deleteTenant: (tenantId) => handlers.deleteTenant(tenantId),
    resetTenant: (tenantId) => handlers.resetTenant(tenantId),
    seedTenant: (tenantId, seed) => handlers.seedTenant(tenantId, validateSyntheticSandboxSeed(seed)),
    hasTenant: (tenantId) => handlers.hasTenant(tenantId),
    snapshotTenant: (tenantId) => handlers.snapshotTenant(tenantId),
    adapterForTenant: (tenantId) => handlers.adapterForTenant(tenantId),
  };
}

export async function runSandboxAdapterConformanceSuite(
  options: SandboxAdapterConformanceOptions,
): Promise<SandboxAdapterConformanceReport> {
  const now = options.now ?? (() => new Date());
  const implementation = options.implementation?.trim() || options.system.name;
  const targetSystem = options.targetSystem ?? options.system.safety.allowedTargetSystems[0];
  const checks: SandboxCertificationCheck[] = [];
  let certification: SandboxCertificationReport | undefined;

  await check(checks, "adapter-contract", "The adapter declares the complete synthetic, network-denied SandboxSystem contract.", async () => {
    if (!options.system.name.trim()) throw new Error("Adapter name is required.");
    if (options.system.safety.mode !== "sandbox" || options.system.safety.networkAccess !== false || options.system.safety.syntheticDataOnly !== true) {
      throw new Error("Adapter safety must be sandbox, network-denied, and synthetic-only.");
    }
    normalizeTargets([...options.system.safety.allowedTargetSystems]);
    return { targetSystems: [...options.system.safety.allowedTargetSystems] };
  });

  await check(checks, "core-certification-v0.1", "The adapter passes the active ten-control Sandbox Certification Harness v0.1 suite.", async () => {
    certification = await runSandboxCertificationSuite({
      system: options.system,
      implementation,
      targetSystem,
      now,
    });
    if (!certification.verdict.passed) {
      throw new Error(`${certification.summary.failed} core certification control(s) failed.`);
    }
    return { score: certification.verdict.score, controls: certification.summary.total };
  });

  await check(checks, "tenant-lifecycle", "Create, inspect, seed, reset, and delete remain isolated behind the tenant lifecycle contract.", async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenantId = `adapter-lifecycle-${suffix}`;
    const harness = createSandboxCertificationHarness({ system: options.system, autoCleanup: false, now });
    try {
      await harness.createTenant({ id: tenantId, synthetic: true, seed: { record: { state: "seed" } } });
      const initial = await harness.snapshotTenant(tenantId);
      if (!isDeepStrictEqual(initial, { record: { state: "seed" } })) throw new Error("Initial tenant snapshot did not match the seed.");
      await harness.seedTenant(tenantId, { record: { state: "replacement" } });
      await harness.resetTenant(tenantId);
      const reset = await harness.snapshotTenant(tenantId);
      if (!isDeepStrictEqual(reset, { record: { state: "replacement" } })) throw new Error("Tenant reset did not restore the replacement seed.");
      await harness.deleteTenant(tenantId);
      if (await options.system.hasTenant(tenantId)) throw new Error("Deleted tenant remains accessible.");
      return { tenantDeleted: true };
    } finally {
      await harness.close();
    }
  });

  await check(checks, "temporary-tenant-cleanup", "Expired tenant leases are removed deterministically from the underlying sandbox.", async () => {
    let current = new Date("2030-01-01T00:00:00.000Z");
    const tenantId = `adapter-expiry-${randomUUID().slice(0, 8)}`;
    const harness = createSandboxCertificationHarness({
      system: options.system,
      tenantTtlMs: 1_000,
      maxTenantTtlMs: 5_000,
      autoCleanup: false,
      now: () => current,
    });
    try {
      const lease = await harness.createTenant({ id: tenantId, synthetic: true, seed: { record: { state: "temporary" } } });
      current = new Date(current.getTime() + 1_001);
      const removed = await harness.cleanupExpiredTenants();
      if (!removed.includes(tenantId) || await options.system.hasTenant(tenantId)) throw new Error("Expired tenant was not deleted.");
      return { expiresAt: lease.expiresAt, removed: true };
    } finally {
      await harness.close();
    }
  });

  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.length - passed;
  return {
    schemaVersion: SANDBOX_ADAPTER_CONFORMANCE_SCHEMA_VERSION,
    kind: "agentcert.sandbox_adapter_conformance",
    implementation,
    generatedAt: now().toISOString(),
    verdict: { passed: failed === 0, score: Math.round((passed / checks.length) * 100) },
    summary: { passed, failed, total: checks.length },
    checks,
    ...(certification ? { certification } : {}),
    disclaimer: "Conformance covers the AgentCert synthetic sandbox adapter contract. It does not authorize production access or certify vendor-side controls.",
  };
}

export async function writeSandboxAdapterConformanceReport(
  report: SandboxAdapterConformanceReport,
  filePath: string,
): Promise<string> {
  const absolutePath = resolve(filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(absolutePath, 0o600);
  return absolutePath;
}

async function check(
  checks: SandboxCertificationCheck[],
  id: string,
  message: string,
  operation: () => Promise<Record<string, unknown> | void>,
): Promise<void> {
  try {
    const evidence = await operation();
    checks.push({ id, status: "passed", message, ...(evidence ? { evidence } : {}) });
  } catch (error) {
    checks.push({ id, status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

function normalizeTargets(input: readonly string[]): string[] {
  const targets = [...new Set(input.map((item) => item.trim()).filter(Boolean))];
  if (targets.length === 0) throw new Error("Sandbox adapters require at least one allowed target system.");
  return targets;
}
