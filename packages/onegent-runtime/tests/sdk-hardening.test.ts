import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonlAuditStore, createStateSandboxAdapter } from "../src/local-adapters.js";
import { createInMemoryExecutionStore, createOnegentRuntime } from "../src/sdk.js";
import { resetActionGatewayStore } from "../src/store.js";
import type { CreateActionIntentInput, LocalActionAdapter, PolicyRule } from "../src/types.js";

const approvalRule: PolicyRule = {
  id: "updates-require-approval",
  name: "Updates require approval",
  description: "All sandbox updates require human approval.",
  actionTypes: ["UPDATE"],
  effect: "REQUIRE_APPROVAL",
  enabled: true,
};
const tempPaths: string[] = [];

beforeEach(resetActionGatewayStore);
afterEach(async () => Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Onegent SDK execution hardening", () => {
  it("executes one adapter call for concurrent retries with the same idempotency key", async () => {
    const executionStore = createInMemoryExecutionStore();
    const runtime = createOnegentRuntime({ policyRules: [approvalRule], executionStore });
    const review = runtime.captureAction(updateAction("account-1", "update-account-1"));
    runtime.approveAction(review.action, "reviewer@example.local", "Approved for sandbox execution.");
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter: LocalActionAdapter = {
      name: "counting-sandbox",
      execute: async (action) => {
        executions += 1;
        await gate;
        return { method: "LOCAL_ADAPTER", previousState: action.beforeState, observedState: action.proposedAfterState };
      },
    };

    const attempts = Array.from({ length: 20 }, () => runtime.executeAfterApproval(review.action, adapter));
    release();
    const results = await Promise.all(attempts);
    expect(executions).toBe(1);
    expect(results.every((result) => result.status === "COMPLETED")).toBe(true);
    await expect(runtime.getExecutionReceipt(review.action)).resolves.toMatchObject({
      idempotencyKey: "update-account-1", actionIntentId: review.action.id, status: "COMPLETED",
    });
  });

  it("rejects reuse of an idempotency key by a different action", async () => {
    const runtime = createOnegentRuntime({ policyRules: [approvalRule] });
    const first = runtime.captureAction(updateAction("account-1", "shared-key"));
    runtime.approveAction(first.action, "reviewer@example.local");
    await runtime.executeAfterApproval(first.action, { name: "first", execute: (action) => ({ observedState: action.proposedAfterState }) });
    const second = runtime.captureAction(updateAction("account-2", "shared-key"));
    runtime.approveAction(second.action, "reviewer@example.local");
    await expect(runtime.executeAfterApproval(second.action, { name: "second", execute: (action) => ({ observedState: action.proposedAfterState }) }))
      .rejects.toThrow("already bound to another action");
  });

  it("restores prior state through an explicit sandbox rollback contract", async () => {
    const adapter = createStateSandboxAdapter({
      allowedTargetSystems: ["SandboxCRM"],
      initialState: { "account-1": { tier: "standard" } },
    });
    const runtime = createOnegentRuntime({ policyRules: [approvalRule] });
    const review = runtime.captureAction({ ...updateAction("account-1", "rollback-1"), targetSystem: "SandboxCRM" });
    runtime.approveAction(review.action, "reviewer@example.local");
    await runtime.executeAfterApproval(review.action, adapter);
    expect(adapter.getState("account-1")).toEqual({ tier: "enterprise" });

    await expect(runtime.rollbackAfterExecution(review.action, adapter, "Customer cancelled the sandbox operation."))
      .resolves.toMatchObject({ status: "ROLLED_BACK", rollback: { success: true, observedState: { tier: "standard" } } });
    expect(adapter.getState("account-1")).toEqual({ tier: "standard" });
    expect(runtime.getActionReview(review.action).action.status).toBe("ROLLED_BACK");
    await expect(runtime.executeAfterApproval(review.action, adapter)).rejects.toThrow("cannot be replayed as completed");
  });

  it("refuses production and non-allowlisted targets in the state sandbox", async () => {
    const adapter = createStateSandboxAdapter({ allowedTargetSystems: ["SandboxCRM"] });
    const runtime = createOnegentRuntime({ policyRules: [approvalRule] });
    const production = runtime.captureAction({ ...updateAction("account-1", "production-1"), targetSystem: "SandboxCRM", environment: "production" });
    expect(() => adapter.execute(production.action)).toThrow("refuses production actions");

    const unlisted = runtime.captureAction({ ...updateAction("account-2", "unlisted-1"), targetSystem: "UnknownCRM" });
    runtime.approveAction(unlisted.action, "reviewer@example.local");
    await expect(runtime.executeAfterApproval(unlisted.action, adapter)).rejects.toThrow("not on the sandbox allowlist");
  });

  it("persists append-only JSONL audit packets with private file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-onegent-"));
    tempPaths.push(directory);
    const auditStore = createJsonlAuditStore(join(directory, "audit", "packets.jsonl"));
    const runtime = createOnegentRuntime({ policyRules: [approvalRule], auditStore });
    const review = runtime.captureAction(updateAction("account-1", "audit-1"));
    runtime.approveAction(review.action, "reviewer@example.local");
    const execution = await runtime.executeAfterApproval(review.action, { name: "audit-adapter", execute: (action) => ({ observedState: action.proposedAfterState }) });
    runtime.verifyOutcome(review.action, execution);
    const packet = await runtime.writeAuditPacket(review.action);

    const records = (await readFile(auditStore.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([packet]);
  });

  it("rejects anonymous or expired approval-adapter decisions", async () => {
    const anonymous = createOnegentRuntime({
      policyRules: [approvalRule],
      approvalAdapter: { name: "anonymous", requestApproval: () => ({ approved: true }) },
    });
    const first = anonymous.captureAction(updateAction("account-1", "approval-1"));
    await expect(anonymous.requestApproval(first.action)).rejects.toThrow("must identify the reviewer");

    resetActionGatewayStore();
    const expired = createOnegentRuntime({
      policyRules: [approvalRule],
      approvalAdapter: {
        name: "expired",
        requestApproval: () => ({ approved: true, reviewerId: "reviewer@example.local", decisionId: "decision-1", expiresAt: "2020-01-01T00:00:00.000Z" }),
      },
    });
    const second = expired.captureAction(updateAction("account-2", "approval-2"));
    await expect(expired.requestApproval(second.action)).rejects.toThrow("has expired");
  });
});

function updateAction(businessObjectId: string, idempotencyKey: string): CreateActionIntentInput {
  return {
    idempotencyKey,
    sourceAgentName: "AccountAgent",
    actionType: "UPDATE",
    targetSystem: "SandboxCRM",
    environment: "demo",
    title: "Update account tier",
    description: "Update synthetic sandbox account state.",
    businessObjectType: "account",
    businessObjectId,
    beforeState: { tier: "standard" },
    proposedAfterState: { tier: "enterprise" },
    fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
  };
}
