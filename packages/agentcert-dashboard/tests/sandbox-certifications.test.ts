import { describe, expect, it } from "vitest";
import type { EvidenceBundleDocument } from "../src/evidence-analysis";
import type { HostedRun } from "../src/hosted-api";
import { isSandboxCertificationRun, sandboxCertificationFromBundle } from "../src/sandbox-certifications";

const sandboxRun: HostedRun = {
  id: "run-1",
  projectId: "project-1",
  externalId: "sandbox:adapter:2030",
  kind: "custom",
  status: "passed",
  score: 1,
  schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2",
  startedAt: "2030-01-01T00:00:00.000Z",
  metadata: {
    productLine: "onegent-runtime",
    evidenceType: "agentcert.sandbox_adapter_conformance",
    implementation: "customer-sandbox",
    sandboxOnly: true,
  },
};

describe("hosted sandbox certification", () => {
  it("classifies sandbox evidence independently from generic custom runs", () => {
    expect(isSandboxCertificationRun(sandboxRun)).toBe(true);
    expect(isSandboxCertificationRun({
      ...sandboxRun,
      schemaVersion: "agentcert.evidence.v0.1",
      metadata: {},
    })).toBe(false);
  });

  it("extracts adapter and nested safety controls from the evidence bundle", () => {
    const bundle: EvidenceBundleDocument = {
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      runId: "sandbox-run",
      generatedAt: "2030-01-01T00:00:00.000Z",
      subject: { name: "customer-sandbox", type: "application" },
      verdict: { passed: true, score: 100, level: "Sandbox conformant" },
      summary: { products: ["onegent-runtime"], criticalEvidence: 0, highEvidence: 0, totalEvidence: 1 },
      results: [],
      evidence: [{
        id: "sandbox-report",
        kind: "sandbox_adapter_conformance",
        severity: "info",
        message: "passed",
        metadata: { report: {
          schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2",
          implementation: "customer-sandbox",
          generatedAt: "2030-01-01T00:00:00.000Z",
          verdict: { passed: true, score: 100 },
          checks: [{ id: "adapter-contract", status: "passed", message: "Adapter contract passed." }],
          certification: { checks: [{ id: "tenant-isolation", status: "passed", message: "Tenant isolation passed." }] },
          disclaimer: "Synthetic evidence only.",
        } },
      }],
      artifacts: {},
      standards: [],
    };

    expect(sandboxCertificationFromBundle(bundle)).toEqual(expect.objectContaining({
      implementation: "customer-sandbox",
      passed: true,
      score: 100,
      checks: [
        expect.objectContaining({ id: "adapter-contract", layer: "adapter" }),
        expect.objectContaining({ id: "tenant-isolation", layer: "safety" }),
      ],
    }));
  });

  it("extracts bounded vendor policy and request audit without raw request data", () => {
    const bundle: EvidenceBundleDocument = {
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      runId: "stripe-sandbox-run",
      generatedAt: "2030-01-01T00:00:00.000Z",
      subject: { name: "stripe-payment-intent-readonly", type: "application" },
      verdict: { passed: true, score: 100, level: "Sandbox conformant" },
      summary: { products: ["onegent-runtime"], criticalEvidence: 0, highEvidence: 0, totalEvidence: 1 },
      results: [],
      evidence: [{
        id: "stripe-report",
        kind: "sandbox_vendor_egress",
        severity: "info",
        message: "passed",
        metadata: { report: {
          schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
          kind: "agentcert.sandbox_vendor_egress",
          implementation: "stripe-payment-intent-readonly",
          vendor: "stripe",
          environment: "sandbox",
          generatedAt: "2030-01-01T00:00:00.000Z",
          verdict: { passed: true, score: 100 },
          checks: [{ id: "bounded-read", status: "passed", message: "Bounded read passed." }],
          policy: {
            allowedOrigins: ["https://api.stripe.com"],
            allowedMethods: ["GET"],
            allowedResources: ["stripe.payment_intent.retrieve"],
            timeoutMs: 5000,
            maxRequestsPerMinute: 10,
          },
          audit: [{ requestId: "stripe-1", resource: "stripe.payment_intent.retrieve", method: "GET", outcome: "allowed", status: 200, durationMs: 24 }],
        } },
      }],
      artifacts: {},
      standards: [],
    };

    expect(sandboxCertificationFromBundle(bundle)).toMatchObject({
      implementation: "stripe-payment-intent-readonly",
      checks: [expect.objectContaining({ id: "bounded-read", layer: "egress" })],
      egressPolicy: {
        vendor: "stripe",
        environment: "sandbox",
        allowedOrigins: ["https://api.stripe.com"],
        allowedMethods: ["GET"],
        allowedResources: ["stripe.payment_intent.retrieve"],
        timeoutMs: 5000,
        maxRequestsPerMinute: 10,
      },
      requestAudit: [expect.objectContaining({ requestId: "stripe-1", outcome: "allowed", status: 200 })],
    });
  });
});
