import { describe, expect, it, vi } from "vitest";
import { createCustomerOwnedBrowserAdapterKit, runCustomerOwnedBrowserAdapterConformance } from "../src/browser-adapter-kit.js";
import { sha256 } from "../src/trust-crypto.js";
import type { ActionIntent } from "../src/types.js";

const expiresAt = "2099-01-01T00:00:00.000Z";

describe("customer-owned browser adapter kit", () => {
  it("proves a bounded sandbox action without leaking credentials", async () => {
    const writeSecret = "write-secret-never-report";
    const readSecret = "read-secret-never-report";
    const revoke = vi.fn();
    const state = { status: "SUBMITTED" };
    const action = fixtureAction();
    const parametersDigest = sha256("fixture-parameters");
    const kit = createCustomerOwnedBrowserAdapterKit({
      name: "customer-browser", targetSystem: "BrowserSandbox", allowedOrigins: ["https://sandbox.example.test"],
      allowedActionTypes: ["SUBMIT"], allowedOperation: "order.submit", allowedResource: "order:ORDER-1", sandbox: true,
      resolveWriteCredential: () => ({ reference: "vault://write", secret: writeSecret, expiresAt }),
      resolveReadCredential: () => ({ reference: "vault://read", secret: readSecret, expiresAt }),
      execute: ({ credential }) => {
        expect(credential).toBe(writeSecret);
        return { observedState: state, targetSystem: "BrowserSandbox" };
      },
      observe: ({ credential }) => {
        expect(credential).toBe(readSecret);
        return { observationId: "observation-1", observedAt: "2026-07-22T00:00:00.000Z", observedState: state, source: "read-api" };
      },
      listAuditEvents: ({ credential }) => {
        expect(credential).toBe(readSecret);
        return [{ targetEventId: "audit-1", actionId: action.id, occurredAt: "2026-07-22T00:00:00.000Z", operation: "order.submit", resource: "order:ORDER-1", parametersDigest, credentialReferenceDigest: sha256("vault://write") }];
      },
      revokeWriteCredential: revoke,
    });

    const report = await runCustomerOwnedBrowserAdapterConformance({
      kit,
      fixture: { action, expectedObservedState: state, expectedAudit: { operation: "order.submit", resource: "order:ORDER-1", parametersDigest }, forbiddenSecrets: [writeSecret, readSecret] },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(report.verdict).toEqual({ passed: true, score: 100 });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(writeSecret);
    expect(JSON.stringify(report)).not.toContain(readSecret);
  });

  it("refuses reused read/write credentials", async () => {
    const kit = createCustomerOwnedBrowserAdapterKit({
      name: "unsafe", targetSystem: "BrowserSandbox", allowedOrigins: ["https://sandbox.example.test"],
      allowedActionTypes: ["SUBMIT"], allowedOperation: "order.submit", allowedResource: "order:ORDER-1", sandbox: true,
      resolveWriteCredential: () => ({ reference: "vault://shared", secret: "shared-secret", expiresAt }),
      resolveReadCredential: () => ({ reference: "vault://shared", secret: "shared-secret", expiresAt }),
      execute: () => ({ observedState: {} }),
      observe: async () => ({ observationId: "x", observedAt: expiresAt, observedState: {}, source: "read" }),
      listAuditEvents: async () => [],
    });
    await expect(kit.prepareExecution()).rejects.toThrow("must be independent");
  });

  it("refuses production actions before customer execution", async () => {
    const execute = vi.fn(() => ({ observedState: {} }));
    const kit = createCustomerOwnedBrowserAdapterKit({
      name: "bounded", targetSystem: "BrowserSandbox", allowedOrigins: ["https://sandbox.example.test"],
      allowedActionTypes: ["SUBMIT"], allowedOperation: "order.submit", allowedResource: "order:ORDER-1", sandbox: true,
      resolveWriteCredential: () => ({ reference: "vault://write", secret: "write-secret", expiresAt }),
      resolveReadCredential: () => ({ reference: "vault://read", secret: "read-secret", expiresAt }),
      execute,
      observe: async () => ({ observationId: "x", observedAt: expiresAt, observedState: {}, source: "read" }),
      listAuditEvents: async () => [],
    });
    const prepared = await kit.prepareExecution();
    await expect(prepared.adapter.execute({ ...fixtureAction(), environment: "production" }, { idempotencyKey: "x", attempt: 1 })).rejects.toThrow("refuses production");
    expect(execute).not.toHaveBeenCalled();
  });
});

function fixtureAction(): ActionIntent {
  return {
    id: "action-1", idempotencyKey: "action-1", workspaceId: "test", workflowId: "test", sourceAgentName: "browser-agent",
    principal: { id: "browser-agent", type: "agent", version: "1.0.0" }, requestedPermissions: ["order.submit"], actionType: "SUBMIT",
    targetSystem: "BrowserSandbox", targetUrl: "https://sandbox.example.test/orders/ORDER-1", environment: "staging", title: "Submit order",
    description: "Conformance", businessObjectType: "order", businessObjectId: "ORDER-1", beforeState: { status: "DRAFT" },
    proposedAfterState: { status: "SUBMITTED" }, fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }],
    createdAt: "2026-07-22T00:00:00.000Z", status: "APPROVED",
  };
}
