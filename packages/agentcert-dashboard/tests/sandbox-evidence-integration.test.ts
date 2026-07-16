import { describe, expect, it } from "vitest";
import { createSandboxCertificationEvidenceBundle } from "../../onegent-runtime/src/sandbox-hosted.js";
import { parseEvidenceBundle } from "../src/evidence-analysis";

describe("hosted sandbox evidence integration", () => {
  it("parses Onegent sandbox certification as a native AgentCert evidence bundle", () => {
    const bundle = createSandboxCertificationEvidenceBundle({
      schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2",
      kind: "agentcert.sandbox_adapter_conformance",
      implementation: "customer-sandbox-adapter",
      generatedAt: "2030-01-01T00:00:00.000Z",
      verdict: { passed: true, score: 100 },
      summary: { passed: 4, failed: 0, total: 4 },
      checks: [],
      disclaimer: "Synthetic sandbox only.",
    });

    expect(parseEvidenceBundle(bundle)).toMatchObject({
      schemaName: "agentcert.evidence_bundle",
      schemaVersion: "agentcert.evidence.v0.1",
      subject: { name: "customer-sandbox-adapter", type: "application" },
      verdict: { passed: true, score: 100, level: "Sandbox conformant" },
      summary: { products: ["onegent-runtime"], totalEvidence: 1 },
      results: [{ product: "onegent-runtime", phase: "pre-release", passed: true, score: 100 }],
    });
  });

  it("wraps bounded vendor sandbox evidence as a first-class sandbox evidence kind", () => {
    const bundle = createSandboxCertificationEvidenceBundle({
      schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
      kind: "agentcert.sandbox_vendor_egress",
      implementation: "stripe-payment-intent-readonly",
      vendor: "stripe",
      environment: "sandbox",
      generatedAt: "2030-01-01T00:00:00.000Z",
      verdict: { passed: true, score: 100 },
      summary: { passed: 5, failed: 0, total: 5 },
      checks: [],
      policy: {
        allowedOrigins: ["https://api.stripe.com"],
        allowedMethods: ["GET"],
        allowedResources: ["stripe.payment_intent.retrieve", "stripe.payment_intent.list"],
        timeoutMs: 5000,
        maxRequestsPerMinute: 10,
      },
      audit: [],
      disclaimer: "Sandbox only.",
    });

    expect(bundle.evidence[0]).toMatchObject({
      kind: "sandbox_vendor_egress",
      metadata: { reportSchemaVersion: "agentcert.sandbox_vendor_egress.v0.4" },
    });
  });
});
