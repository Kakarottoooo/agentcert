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
});
