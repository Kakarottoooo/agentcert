import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxSystemAdapter,
  runSandboxAdapterConformanceSuite,
} from "../src/sandbox-adapter-kit.js";
import { createInMemorySandboxSystem } from "../src/sandbox-harness.js";
import {
  createSandboxCertificationEvidenceBundle,
  uploadSandboxCertificationReport,
} from "../src/sandbox-hosted.js";
import { createStripeTestModeReadOnlyAdapter, STRIPE_TEST_API_ORIGIN } from "../src/stripe-test-readonly.js";
import { resetActionGatewayStore } from "../src/store.js";

beforeEach(resetActionGatewayStore);

describe("Sandbox Adapter Kit v0.2", () => {
  it("builds a guarded third-party adapter and passes the conformance suite", async () => {
    const backing = createInMemorySandboxSystem({ name: "backing", allowedTargetSystems: ["PartnerSandbox"] });
    const system = createSandboxSystemAdapter({
      name: "partner-adapter",
      allowedTargetSystems: ["PartnerSandbox", "PartnerSandbox"],
      handlers: {
        createTenant: (input) => backing.createTenant(input),
        deleteTenant: (tenantId) => backing.deleteTenant(tenantId),
        resetTenant: (tenantId) => backing.resetTenant(tenantId),
        seedTenant: (tenantId, seed) => backing.seedTenant(tenantId, seed),
        hasTenant: (tenantId) => backing.hasTenant(tenantId),
        snapshotTenant: (tenantId) => backing.snapshotTenant(tenantId),
        adapterForTenant: (tenantId) => backing.adapterForTenant(tenantId),
      },
    });

    expect(system.safety).toEqual({
      mode: "sandbox",
      networkAccess: false,
      syntheticDataOnly: true,
      allowedTargetSystems: ["PartnerSandbox"],
    });
    expect(() => system.createTenant({ id: "unsafe-seed", synthetic: true, seed: { account: { password: "x" } } }))
      .toThrow("Credential-like field");

    const report = await runSandboxAdapterConformanceSuite({ system });
    expect(report).toMatchObject({
      schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2",
      kind: "agentcert.sandbox_adapter_conformance",
      verdict: { passed: true, score: 100 },
      summary: { passed: 4, failed: 0, total: 4 },
      certification: { verdict: { passed: true, score: 100 }, summary: { total: 10 } },
    });
  });

  it("rejects incomplete adapter definitions before they can claim conformance", () => {
    const handlers = {
      createTenant: () => undefined,
      deleteTenant: () => undefined,
      resetTenant: () => undefined,
      seedTenant: () => undefined,
      hasTenant: () => false,
      snapshotTenant: () => ({}),
      adapterForTenant: undefined,
    };
    expect(() => createSandboxSystemAdapter({
      name: "incomplete",
      allowedTargetSystems: ["Sandbox"],
      handlers: handlers as never,
    })).toThrow("adapterForTenant");
  });
});

describe("Stripe Test Mode read-only reference adapter", () => {
  it("allows only restricted test keys, fixed GET endpoints, and redacted snapshots", async () => {
    expect(() => createStripeTestModeReadOnlyAdapter({ restrictedApiKey: "rk_live_not_allowed" })).toThrow("rk_test_");
    expect(() => createStripeTestModeReadOnlyAdapter({ restrictedApiKey: "sk_test_too_broad" })).toThrow("rk_test_");
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${STRIPE_TEST_API_ORIGIN}/v1/payment_intents/pi_12345678`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_test_reference_key_123");
      return Response.json({
        id: "pi_12345678",
        object: "payment_intent",
        livemode: false,
        amount: 4850,
        amount_received: 4850,
        currency: "usd",
        status: "succeeded",
        client_secret: "must-not-leave-adapter",
        metadata: { customer_email: "must-not-leave-adapter" },
      });
    });
    const adapter = createStripeTestModeReadOnlyAdapter({
      restrictedApiKey: "rk_test_reference_key_123",
      fetch: requestFetch as typeof fetch,
    });

    const snapshot = await adapter.retrievePaymentIntent("pi_12345678");
    expect(snapshot).toEqual({
      id: "pi_12345678",
      object: "payment_intent",
      livemode: false,
      amount: 4850,
      amountReceived: 4850,
      currency: "usd",
      status: "succeeded",
    });
    expect(snapshot).not.toHaveProperty("client_secret");
    expect(snapshot).not.toHaveProperty("metadata");
    await expect(adapter.retrievePaymentIntent("../charges")).rejects.toThrow("ID is invalid");
  });

  it("bounds list reads and refuses any response that is not explicitly test mode", async () => {
    const requestFetch = vi.fn(async () => Response.json({
      object: "list",
      data: [{ id: "pi_87654321", object: "payment_intent", livemode: true }],
    }));
    const adapter = createStripeTestModeReadOnlyAdapter({
      restrictedApiKey: "rk_test_reference_key_456",
      fetch: requestFetch as typeof fetch,
    });
    await expect(adapter.listPaymentIntents(11)).rejects.toThrow("1 to 10");
    await expect(adapter.listPaymentIntents(1)).rejects.toThrow("not explicitly test mode");
  });
});

describe("Hosted sandbox certification upload", () => {
  const report = {
    schemaVersion: "agentcert.sandbox_certification.v0.1" as const,
    kind: "agentcert.sandbox_certification" as const,
    implementation: "partner-adapter",
    generatedAt: "2030-01-01T00:00:00.000Z",
    verdict: { passed: true, score: 100 },
    summary: { passed: 10, failed: 0, total: 10 },
    checks: [],
    runIds: [],
    disclaimer: "Synthetic only.",
  };

  it("wraps the report as manifest-complete evidence and records one hosted run", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/runs")) return Response.json({ id: "run-hosted-1", status: "running" }, { status: 201 });
      if (url.includes("/evidence?")) return Response.json({ id: "evidence-1", sha256: "a".repeat(64) }, { status: 201 });
      if (url.endsWith("/runs/run-hosted-1/complete")) return Response.json({ id: "run-hosted-1", status: "passed" });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });

    const result = await uploadSandboxCertificationReport(report, {
      baseUrl: "https://agentcert.example/",
      projectId: "project-1",
      apiKey: "ac_test_key",
      fetch: requestFetch as typeof fetch,
    });
    expect(result).toMatchObject({
      run: { id: "run-hosted-1" },
      evidence: { id: "evidence-1" },
      completion: { status: "passed" },
    });
    expect(requests).toHaveLength(3);
    expect(new Headers(requests[0].init?.headers).get("idempotency-key")).toMatch(/^sandbox-upload-.+:run$/);
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      kind: "custom",
      schemaVersion: report.schemaVersion,
      metadata: { productLine: "onegent-runtime", sandboxOnly: true },
    });
    const evidenceBytes = Buffer.from(requests[1].init?.body as ArrayBuffer);
    const bundle = JSON.parse(evidenceBytes.toString("utf8"));
    expect(bundle).toMatchObject({
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      schemaSemver: "0.1.0",
      kind: "agentcert.evidence_bundle",
      subject: { name: "partner-adapter", type: "application" },
      results: [{ product: "onegent-runtime", evidence: [{ metadata: { report } }] }],
      artifactManifest: { schemaVersion: "agentcert.artifact_manifest.v0.1", entries: [] },
    });
    expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({ status: "passed", score: 1 });
    expect(new Headers(requests[2].init?.headers).get("authorization")).toBe("Bearer ac_test_key");
  });

  it("creates a stable bundle contract and surfaces hosted errors without exposing credentials", async () => {
    const bundle = createSandboxCertificationEvidenceBundle(report);
    const retriedBundle = createSandboxCertificationEvidenceBundle(report);
    expect(bundle.results[0].evidence[0].metadata.report).toEqual(report);
    expect(bundle.artifactManifest.entries).toEqual([]);
    expect(retriedBundle.runId).toBe(bundle.runId);
    const requestFetch = vi.fn(async () => Response.json({ error: "API key scope requires runs:write" }, { status: 403 }));
    const failure = uploadSandboxCertificationReport(report, {
      baseUrl: "https://agentcert.example",
      projectId: "project-1",
      apiKey: "must-not-appear-in-error",
      fetch: requestFetch as typeof fetch,
    });
    await expect(failure).rejects.toThrow("requires runs:write");
    await failure.catch((error: Error) => expect(error.message).not.toContain("must-not-appear-in-error"));
  });

  it("marks protected vendor acceptance runs with safe comparison metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/runs")) return Response.json({ id: "vendor-run-1" }, { status: 201 });
      if (url.includes("/evidence?")) return Response.json({ id: "evidence-1", sha256: "a".repeat(64) }, { status: 201 });
      return Response.json({ id: "vendor-run-1", status: "passed" });
    });
    const vendorReport = {
      schemaVersion: "agentcert.sandbox_vendor_egress.v0.4" as const,
      kind: "agentcert.sandbox_vendor_egress" as const,
      implementation: "stripe-payment-intent-readonly" as const,
      vendor: "stripe" as const,
      environment: "sandbox" as const,
      generatedAt: "2030-01-01T00:00:00.000Z",
      verdict: { passed: true, score: 100 },
      summary: { passed: 5, failed: 0, total: 5 },
      checks: [],
      policy: {
        allowedOrigins: [STRIPE_TEST_API_ORIGIN] as const,
        allowedMethods: ["GET"] as const,
        allowedResources: ["stripe.payment_intent.retrieve", "stripe.payment_intent.list"] as const,
        timeoutMs: 5000,
        maxRequestsPerMinute: 10,
      },
      audit: [{
        requestId: "stripe-1",
        timestamp: "2030-01-01T00:00:00.000Z",
        vendor: "stripe",
        resource: "stripe.payment_intent.retrieve",
        method: "GET" as const,
        origin: STRIPE_TEST_API_ORIGIN,
        outcome: "allowed" as const,
        durationMs: 84,
        status: 200,
      }],
      disclaimer: "Sandbox only.",
    };

    await uploadSandboxCertificationReport(vendorReport, {
      baseUrl: "https://agentcert.example",
      projectId: "project-1",
      apiKey: "ac_test_key",
      externalId: "vendor-acceptance:stripe:123:1",
      fetch: requestFetch as typeof fetch,
    });

    const body = JSON.parse(String(requests[0].init?.body));
    expect(body.metadata).toMatchObject({
      vendor: "stripe",
      environment: "sandbox",
      acceptanceType: "real_vendor_sandbox",
      requestDurationMs: 84,
      policySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(body)).not.toContain("authorization");
  });
});
