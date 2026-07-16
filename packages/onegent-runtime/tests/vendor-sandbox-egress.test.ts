import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBoundedVendorSandboxEgress,
  type VendorSandboxEgressPolicy,
} from "../src/vendor-sandbox-egress.js";
import {
  runStripeSandboxReadOnlyCertification,
  STRIPE_PAYMENT_INTENT_RETRIEVE,
  STRIPE_TEST_API_ORIGIN,
} from "../src/stripe-test-readonly.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const policy: VendorSandboxEgressPolicy = {
  vendor: "example",
  allowedOrigin: "https://sandbox.vendor.example",
  resources: [{ id: "invoice.retrieve", method: "GET", pathPattern: /^\/v1\/invoices\/inv_[A-Za-z0-9]+$/ }],
  timeoutMs: 100,
  maxRequestsPerMinute: 2,
};

describe("Bounded vendor sandbox egress v0.4", () => {
  it("denies non-allowlisted origins, methods, and resources before fetch", async () => {
    const requestFetch = vi.fn();
    const egress = createBoundedVendorSandboxEgress({ policy, fetch: requestFetch as typeof fetch });

    await expect(egress.requestJson({
      resource: "invoice.retrieve",
      method: "GET",
      path: "https://attacker.example/v1/invoices/inv_1",
    })).rejects.toMatchObject({ code: "ORIGIN_DENIED" });
    await expect(egress.requestJson({
      resource: "invoice.write",
      method: "GET",
      path: "/v1/invoices/inv_1",
    })).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    await expect(egress.requestJson({
      resource: "invoice.retrieve",
      method: "POST",
      path: "/v1/invoices/inv_1",
    } as never)).rejects.toMatchObject({ code: "METHOD_DENIED" });

    expect(requestFetch).not.toHaveBeenCalled();
    expect(egress.getAuditLog().map((entry) => entry.outcome)).toEqual(["denied", "denied", "denied"]);
  });

  it("times out deterministically and does not wait for a stuck fetch", async () => {
    vi.useFakeTimers();
    const requestFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const egress = createBoundedVendorSandboxEgress({ policy, fetch: requestFetch as typeof fetch });
    const request = egress.requestJson({
      resource: "invoice.retrieve",
      method: "GET",
      path: "/v1/invoices/inv_1",
    });
    const rejection = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(egress.getAuditLog()).toEqual([expect.objectContaining({ outcome: "timeout", errorCode: "TIMEOUT" })]);
  });

  it("enforces a deterministic per-minute request cap", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const requestFetch = vi.fn(async () => Response.json({ id: "inv_1" }));
    const egress = createBoundedVendorSandboxEgress({
      policy: { ...policy, maxRequestsPerMinute: 1 },
      fetch: requestFetch as typeof fetch,
      now: () => now,
    });
    const input = { resource: "invoice.retrieve", method: "GET" as const, path: "/v1/invoices/inv_1" };

    await expect(egress.requestJson(input)).resolves.toEqual({ id: "inv_1" });
    await expect(egress.requestJson(input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    now += 60_000;
    await expect(egress.requestJson(input)).resolves.toEqual({ id: "inv_1" });
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps credentials, request headers, and raw responses out of audit evidence", async () => {
    const secret = "rk_test_must_never_enter_evidence";
    const egress = createBoundedVendorSandboxEgress({
      policy,
      fetch: vi.fn(async () => Response.json({ secret, client_secret: secret })) as typeof fetch,
    });
    await egress.requestJson({
      resource: "invoice.retrieve",
      method: "GET",
      path: "/v1/invoices/inv_1",
      headers: { authorization: `Bearer ${secret}` },
    });

    const encoded = JSON.stringify(egress.getAuditLog());
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("authorization");
    expect(encoded).not.toContain("client_secret");
  });
});

describe("Stripe sandbox read-only evidence", () => {
  it("produces a redacted, auditable report for one real-shaped sandbox read", async () => {
    const secret = "rk_test_reference_key_999";
    const report = await runStripeSandboxReadOnlyCertification({
      restrictedApiKey: secret,
      paymentIntentId: "pi_12345678",
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      fetch: vi.fn(async (input, init) => {
        expect(String(input)).toBe(`${STRIPE_TEST_API_ORIGIN}/v1/payment_intents/pi_12345678`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
        return Response.json({
          id: "pi_12345678",
          object: "payment_intent",
          livemode: false,
          amount: 4850,
          currency: "usd",
          status: "succeeded",
          client_secret: "pi_secret_never_retained",
          metadata: { email: "private@example.com" },
        });
      }) as typeof fetch,
    });

    expect(report).toMatchObject({
      schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
      kind: "agentcert.sandbox_vendor_egress",
      verdict: { passed: true, score: 100 },
      policy: { allowedOrigins: [STRIPE_TEST_API_ORIGIN], allowedMethods: ["GET"] },
      observation: { id: "pi_12345678", livemode: false, amount: 4850 },
      audit: [{ resource: STRIPE_PAYMENT_INTENT_RETRIEVE, outcome: "allowed", status: 200 }],
    });
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("pi_secret_never_retained");
    expect(encoded).not.toContain("private@example.com");
    expect(encoded).not.toContain("authorization");
  });

  it("returns failed evidence instead of leaking vendor or credential details", async () => {
    const report = await runStripeSandboxReadOnlyCertification({
      restrictedApiKey: "rk_test_reference_key_000",
      paymentIntentId: "pi_12345678",
      fetch: vi.fn(async () => Response.json({ error: { message: "secret vendor detail" } }, { status: 403 })) as typeof fetch,
    });
    expect(report.verdict.passed).toBe(false);
    expect(report.audit).toEqual([expect.objectContaining({ outcome: "http_error", status: 403 })]);
    expect(JSON.stringify(report)).not.toContain("secret vendor detail");
  });
});
