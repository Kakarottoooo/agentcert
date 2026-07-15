import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../src/bundle.js";
import {
  buildReleaseGateReport,
  RELEASE_GATE_CONTROL_IDS,
  writeReleaseGateArtifacts,
  type ReleaseGateAttestation,
  type ReleaseGateControlId,
} from "../src/release-gate.js";
import type { AgentCertResult } from "../src/types.js";

describe("AgentCert release gate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentcert-release-gate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("computes automated controls and leaves unproven controls observable", async () => {
    const artifact = join(dir, "result.json");
    await writeFile(artifact, "{}\n");
    const report = await buildReleaseGateReport(completeBundle(artifact), {
      sourceArtifacts: { tripwire: artifact },
      evidenceBundlePath: artifact,
    });

    expect(report.verdict.passed).toBe(true);
    expect(report.controls).toHaveLength(10);
    expect(control(report, "permission-boundary").status).toBe("pass");
    expect(control(report, "tool-contract").status).toBe("pass");
    expect(control(report, "state-verification").status).toBe("pass");
    expect(control(report, "human-handoff").status).toBe("pass");
    expect(control(report, "data-boundary").status).toBe("needs-evidence");
    expect(report.provenance.sourceArtifacts[0]).toMatchObject({ status: "verified" });
    expect(report.provenance.sourceArtifacts[0]?.sha256).toHaveLength(64);
  });

  it("blocks strict release until every evidence-required and manual control is attested", async () => {
    const bundle = completeBundle(join(dir, "result.json"));
    const strict = await buildReleaseGateReport(bundle, { strict: true });

    expect(strict.verdict.passed).toBe(false);
    expect(strict.verdict.blockers).toContain("Sensitive data boundary: evidence is required in strict mode.");

    const attestations = Object.fromEntries(
      RELEASE_GATE_CONTROL_IDS.map((id) => [id, attestation(id)]),
    ) as Record<ReleaseGateControlId, ReleaseGateAttestation>;
    const attested = await buildReleaseGateReport(bundle, { strict: true, attestations });

    expect(attested.verdict.passed).toBe(true);
    expect(attested.controls.every((item) => item.status === "pass")).toBe(true);
  });

  it("does not let a manual attestation override failed automated evidence", async () => {
    const results = completeResults(join(dir, "result.json"));
    const tripwire = results.find((result) => result.product === "tripwire-ci");
    if (!tripwire) throw new Error("Tripwire fixture missing.");
    tripwire.passed = false;
    tripwire.score = 0;
    const report = await buildReleaseGateReport(buildEvidenceBundle(results, "demo-agent"), {
      attestations: { "state-verification": attestation("state-verification") },
    });

    expect(control(report, "state-verification").status).toBe("fail");
    expect(report.verdict.passed).toBe(false);
  });

  it("does not let an attestation replace a missing automated engine", async () => {
    const bundle = buildEvidenceBundle([result("tripwire-ci", "pre-release", join(dir, "tripwire.json"))], "demo-agent");
    const report = await buildReleaseGateReport(bundle, {
      attestations: { "tool-contract": attestation("tool-contract") },
    });

    expect(control(report, "tool-contract").status).toBe("needs-evidence");
    expect(control(report, "tool-contract").summary).toContain("cannot replace missing automated evidence");
  });

  it("detects score and product regressions against a baseline", async () => {
    const baseline = completeBundle(join(dir, "baseline.json"));
    const currentResults = completeResults(join(dir, "current.json"));
    const tripwire = currentResults.find((result) => result.product === "tripwire-ci");
    if (!tripwire) throw new Error("Tripwire fixture missing.");
    tripwire.score = 60;
    tripwire.passed = false;
    const current = buildEvidenceBundle(currentResults, "demo-agent");
    const report = await buildReleaseGateReport(current, { baseline, maxScoreDrop: 5 });

    expect(report.regression.status).toBe("fail");
    expect(report.regression.regressions).toContain("tripwire-ci changed from pass to fail.");
    expect(report.verdict.passed).toBe(false);
  });

  it("writes stable JSON, HTML, JUnit, Markdown, and badge outputs", async () => {
    const report = await buildReleaseGateReport(completeBundle(join(dir, "result.json")));
    const paths = await writeReleaseGateArtifacts(join(dir, "out"), report);

    expect(JSON.parse(await readFile(paths.json, "utf8")).schemaVersion).toBe("agentcert.release_gate.v0.1");
    expect(await readFile(paths.html, "utf8")).toContain("Ten release controls");
    expect(await readFile(paths.junit, "utf8")).toContain('tests="11"');
    expect(await readFile(paths.markdown, "utf8")).toContain("## Provenance");
    expect(await readFile(paths.badge, "utf8")).toContain("agentcert release");
  });
});

function completeBundle(artifact: string) {
  return buildEvidenceBundle(completeResults(artifact), "demo-agent");
}

function completeResults(artifact: string): AgentCertResult[] {
  return [
    result("mcpbench", "pre-release", artifact),
    result("tripwire-ci", "pre-release", artifact),
    {
      ...result("onegent-runtime", "runtime", artifact),
      evidence: [
        {
          id: "principal",
          kind: "runtime_identity",
          severity: "info",
          message: "Principal recorded.",
          artifactPath: artifact,
        },
        {
          id: "authorization",
          kind: "authorization_decision",
          severity: "info",
          message: "Authorization allowed.",
          artifactPath: artifact,
          metadata: { decision: "ALLOW" },
        },
        {
          id: "risk",
          kind: "runtime_risk_assessment",
          severity: "high",
          message: "High risk.",
          artifactPath: artifact,
          metadata: { requiresHumanApproval: true },
        },
        {
          id: "approval",
          kind: "approval_record",
          severity: "info",
          message: "Approved.",
          artifactPath: artifact,
          metadata: { status: "APPROVED" },
        },
      ],
    },
  ];
}

function result(product: AgentCertResult["product"], phase: AgentCertResult["phase"], artifact: string): AgentCertResult {
  return {
    schemaVersion: "1",
    product,
    phase,
    runId: `${product}-run`,
    timestamp: "2026-01-01T00:00:00Z",
    score: 100,
    passed: true,
    artifacts: { result: artifact },
    evidence: [],
  };
}

function control(report: Awaited<ReturnType<typeof buildReleaseGateReport>>, id: ReleaseGateControlId) {
  const value = report.controls.find((item) => item.id === id);
  if (!value) throw new Error(`Control ${id} not found.`);
  return value;
}

function attestation(id: ReleaseGateControlId): ReleaseGateAttestation {
  return {
    status: "pass",
    owner: "security@example.com",
    reviewedAt: "2026-01-01T00:00:00Z",
    evidence: [`docs/controls/${id}.md`],
    note: `${id} reviewed.`,
  };
}
