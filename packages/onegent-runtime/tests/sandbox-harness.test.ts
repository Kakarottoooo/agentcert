import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySandboxSystem,
  createSandboxCertificationHarness,
  runSandboxCertificationSuite,
  writeSandboxReport,
} from "../src/sandbox-harness.js";
import { resetActionGatewayStore } from "../src/store.js";
import type { CreateActionIntentInput } from "../src/types.js";

const tempPaths: string[] = [];

beforeEach(resetActionGatewayStore);
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Sandbox Certification Harness v0.1", () => {
  it("isolates tenant state and restores deterministic synthetic seeds", async () => {
    const harness = await harnessWithTenants();
    const mismatch = await harness.startRun({ tenantId: "tenant-a", runId: "isolation" });
    await expect(mismatch.executeAction(action({ workspaceId: "tenant-b" }), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "TENANT_MISMATCH" });

    const mutation = await harness.startRun({ tenantId: "tenant-a", runId: "mutation" });
    await expect(mutation.executeAction(action(), approved())).resolves.toMatchObject({ status: "verified" });
    expect(await harness.snapshotTenant("tenant-a")).toEqual({ account: { tier: "enterprise" } });
    expect(await harness.snapshotTenant("tenant-b")).toEqual({ account: { tier: "restricted" } });

    await harness.resetTenant("tenant-a");
    expect(await harness.snapshotTenant("tenant-a")).toEqual({ account: { tier: "standard" } });
    await expect(harness.seedTenant("tenant-a", { account: { apiKey: "not-allowed" } })).rejects.toThrow("Credential-like field");
  });

  it("leases temporary tenants, supports bounded renewal, and cleans them automatically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const system = createInMemorySandboxSystem({ allowedTargetSystems: ["SandboxCRM"] });
    const harness = createSandboxCertificationHarness({
      system,
      tenantTtlMs: 200,
      maxTenantTtlMs: 1_000,
      cleanupIntervalMs: 50,
    });
    const lease = await harness.createTenant({ id: "temporary", synthetic: true });
    expect(lease).toMatchObject({ tenantId: "temporary", expiresAt: "2030-01-01T00:00:00.200Z" });

    await vi.advanceTimersByTimeAsync(100);
    const renewed = await harness.renewTenant("temporary", 300);
    expect(renewed.expiresAt).toBe("2030-01-01T00:00:00.400Z");
    await expect(harness.renewTenant("temporary", 1_001)).rejects.toThrow("cannot exceed 1000");

    await vi.advanceTimersByTimeAsync(301);
    expect(await system.hasTenant("temporary")).toBe(false);
    expect(harness.tenantLease("temporary")).toBeUndefined();
    await expect(harness.startRun({ tenantId: "temporary" })).rejects.toThrow("lease expired");
    await harness.close();
    await expect(harness.createTenant({ id: "closed", synthetic: true })).rejects.toThrow("closed");
  });

  it("fails closed for production, network, target, and approval violations", async () => {
    const harness = await harnessWithTenants();
    const cases: Array<[string, Partial<CreateActionIntentInput>, string, ReturnType<typeof approved> | undefined]> = [
      ["production", { environment: "production" }, "PRODUCTION_DENIED", approved()],
      ["network", { targetUrl: "https://example.invalid/write" }, "NETWORK_DENIED", approved()],
      ["target", { targetSystem: "ProductionCRM" }, "TARGET_NOT_ALLOWED", approved()],
      ["approval", {}, "APPROVAL_REQUIRED", undefined],
      ["idempotency", { idempotencyKey: undefined }, "IDEMPOTENCY_REQUIRED", approved()],
    ];

    for (const [runId, override, rejectionCode, options] of cases) {
      const run = await harness.startRun({ tenantId: "tenant-a", runId });
      const result = await run.executeAction(action(override), options);
      expect(result).toMatchObject({ status: "rejected", rejectionCode });
    }
    expect(await harness.snapshotTenant("tenant-a")).toEqual({ account: { tier: "standard" } });
  });

  it("enforces exact action and amount budgets", async () => {
    const harness = createSandboxCertificationHarness({
      allowedTargetSystems: ["SandboxCRM"],
      limits: { maxActionsPerRun: 2, maxAmountPerAction: 100, maxTotalAmountPerRun: 150 },
    });
    await harness.createTenant({ id: "tenant-a", synthetic: true, seed: { account: { tier: "standard" } } });
    const run = await harness.startRun({ tenantId: "tenant-a", runId: "limits" });
    await expect(run.executeAction(action({ amount: 80, idempotencyKey: "amount-1" }), approved()))
      .resolves.toMatchObject({ status: "verified" });
    await expect(run.executeAction(action({ amount: 80, idempotencyKey: "amount-2" }), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "RUN_AMOUNT_LIMIT_EXCEEDED" });
    await expect(run.executeAction(action({ amount: 0, idempotencyKey: "amount-3" }), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "ACTION_LIMIT_EXCEEDED" });

    const perAction = await harness.startRun({ tenantId: "tenant-a", runId: "per-action" });
    await expect(perAction.executeAction(action({ amount: 101 }), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "AMOUNT_LIMIT_EXCEEDED" });
  });

  it("stops execution with tenant and global kill switches", async () => {
    const harness = await harnessWithTenants();
    harness.setTenantKillSwitch("tenant-a", true, "Tenant incident.");
    const tenantRun = await harness.startRun({ tenantId: "tenant-a", runId: "tenant-kill" });
    await expect(tenantRun.executeAction(action(), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "TENANT_KILL_SWITCH", message: "Tenant incident." });

    harness.setTenantKillSwitch("tenant-a", false);
    const returnedState = harness.setGlobalKillSwitch(true, "Platform incident.");
    returnedState.enabled = false;
    const globalRun = await harness.startRun({ tenantId: "tenant-a", runId: "global-kill" });
    await expect(globalRun.executeAction(action(), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "GLOBAL_KILL_SWITCH", message: "Platform incident." });
    expect(await harness.snapshotTenant("tenant-a")).toEqual({ account: { tier: "standard" } });
  });

  it("deduplicates concurrent retries and rejects conflicting idempotency reuse", async () => {
    const harness = await harnessWithTenants();
    const run = await harness.startRun({ tenantId: "tenant-a", runId: "idempotency" });
    const input = action({ idempotencyKey: "same-key" });
    const [first, second] = await Promise.all([run.executeAction(input, approved()), run.executeAction(input, approved())]);
    expect(first.actionIntentId).toBeTruthy();
    expect(second.actionIntentId).toBe(first.actionIntentId);

    await expect(run.executeAction(action({ idempotencyKey: "same-key", proposedAfterState: { tier: "platinum" } }), approved()))
      .resolves.toMatchObject({ status: "rejected", rejectionCode: "IDEMPOTENCY_CONFLICT" });
    const report = run.complete();
    expect(report.summary).toMatchObject({ attempted: 2, verified: 1, rejected: 1, failed: 0 });
    expect(report.actions).toHaveLength(2);
  });

  it("verifies approved execution, records audit evidence, and restores state through rollback", async () => {
    const harness = await harnessWithTenants();
    const rejectedRun = await harness.startRun({ tenantId: "tenant-a", runId: "human-reject" });
    const rejected = await rejectedRun.executeAction(action(), {
      approval: { approved: false, reviewerId: "reviewer@example.local", comment: "Not justified." },
    });
    expect(rejected).toMatchObject({ status: "rejected", rejectionCode: "APPROVAL_REJECTED" });
    expect(rejected.auditPacket?.approvalRequest).toMatchObject({ status: "REJECTED" });

    const run = await harness.startRun({ tenantId: "tenant-a", runId: "rollback" });
    const result = await run.executeAction(action({ idempotencyKey: "rollback-key" }), {
      ...approved(),
      rollbackAfterVerification: true,
      rollbackReason: "Certification cleanup.",
    });
    expect(result).toMatchObject({
      status: "rolled_back",
      verification: { success: true },
      rollback: { status: "ROLLED_BACK", rollback: { success: true, reason: "Certification cleanup." } },
    });
    expect(result.auditPacket?.auditEvents.some((event) => event.eventType === "ROLLBACK_COMPLETED")).toBe(true);
    expect(result.auditPacket?.scenario).toBe("UPDATE account action in SandboxCRM");
    expect(await harness.snapshotTenant("tenant-a")).toEqual({ account: { tier: "standard" } });
  });

  it("actively certifies all ten v0.1 controls and writes a private report", async () => {
    const report = await runSandboxCertificationSuite({ implementation: "reference-test" });
    expect(report).toMatchObject({
      schemaVersion: "agentcert.sandbox_certification.v0.1",
      kind: "agentcert.sandbox_certification",
      implementation: "reference-test",
      verdict: { passed: true, score: 100 },
      summary: { passed: 10, failed: 0, total: 10 },
    });
    expect(new Set(report.checks.map((item) => item.id))).toEqual(new Set([
      "tenant-isolation", "synthetic-data-only", "deny-network-egress", "target-allowlist", "production-deny",
      "approval-gate", "execution-limits", "kill-switches", "idempotent-execution", "verification-rollback-reset",
    ]));

    const directory = await mkdtemp(join(tmpdir(), "agentcert-sandbox-report-"));
    tempPaths.push(directory);
    const filePath = await writeSandboxReport(report, join(directory, "reports", "sandbox-certification.json"));
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    expect(saved.verdict).toEqual({ passed: true, score: 100 });
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    resetActionGatewayStore();
    const custom = await runSandboxCertificationSuite({
      system: createInMemorySandboxSystem({ name: "customer-sandbox", allowedTargetSystems: ["SandboxERP"] }),
      implementation: "customer-adapter",
    });
    expect(custom.verdict).toEqual({ passed: true, score: 100 });
  });

  it("rejects systems that are not synthetic and network-denied", () => {
    const system = createInMemorySandboxSystem({ allowedTargetSystems: ["SandboxCRM"] });
    const unsafe = { ...system, safety: { ...system.safety, networkAccess: true } };
    expect(() => createSandboxCertificationHarness({ system: unsafe as never })).toThrow("accepts only synthetic, network-denied");
  });

  it("cleans an already-created certification tenant when adapter setup fails", async () => {
    const backing = createInMemorySandboxSystem({ allowedTargetSystems: ["SandboxCRM"] });
    let creates = 0;
    let deletes = 0;
    const system = {
      ...backing,
      createTenant: async (input: Parameters<typeof backing.createTenant>[0]) => {
        creates += 1;
        if (creates === 2) throw new Error("adapter setup failed");
        await backing.createTenant(input);
      },
      deleteTenant: async (tenantId: string) => {
        deletes += 1;
        await backing.deleteTenant(tenantId);
      },
    };
    await expect(runSandboxCertificationSuite({ system })).rejects.toThrow("adapter setup failed");
    expect(deletes).toBe(1);
  });
});

async function harnessWithTenants() {
  const harness = createSandboxCertificationHarness({ allowedTargetSystems: ["SandboxCRM"] });
  await harness.createTenant({ id: "tenant-a", synthetic: true, seed: { account: { tier: "standard" } } });
  await harness.createTenant({ id: "tenant-b", synthetic: true, seed: { account: { tier: "restricted" } } });
  return harness;
}

function action(overrides: Partial<CreateActionIntentInput> = {}): CreateActionIntentInput {
  return {
    idempotencyKey: `action-${Math.random()}`,
    sourceAgentName: "SandboxAgent",
    actionType: "UPDATE",
    targetSystem: "SandboxCRM",
    environment: "demo",
    title: "Update synthetic account",
    description: "Update a deterministic local-only sandbox record.",
    businessObjectType: "account",
    businessObjectId: "account",
    amount: 25,
    currency: "USD",
    beforeState: { tier: "standard" },
    proposedAfterState: { tier: "enterprise" },
    fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
    ...overrides,
  };
}

function approved() {
  return { approval: { approved: true, reviewerId: "reviewer@example.local", comment: "Approved for test sandbox." } };
}
