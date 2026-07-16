import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PUBLIC_VENDOR_ACCEPTANCE_SCHEMA,
  assertNoSensitiveMaterial,
  buildPublicVendorAcceptance,
} from "./build-public-vendor-acceptance.mjs";

test("builds a stable anonymized public report from two protected runs", () => {
  const report = buildPublicVendorAcceptance([
    record("29481436126", "baseline", "2026-07-16T07:53:22.063Z", 288, "a".repeat(64)),
    record("29481517989", "stable", "2026-07-16T07:54:41.410Z", 269, "b".repeat(64), 2),
  ]);

  assert.equal(report.schemaVersion, PUBLIC_VENDOR_ACCEPTANCE_SCHEMA);
  assert.equal(report.verdict.passed, true);
  assert.equal(report.summary.totalRuns, 2);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.runs[1].trend, "stable");
  assert.equal(report.disclosure.anonymized, true);
  assert.doesNotMatch(JSON.stringify(report), /vendor-acceptance:stripe/);
  assert.doesNotMatch(JSON.stringify(report), /\bpi_/i);
});

test("rejects any vendor object identifier or credential-shaped material", () => {
  for (const value of [
    "pi_public_leak_123",
    "rk_test_public_leak_123",
    "sk_live_public_leak_123",
    "Bearer public-leak",
    "client_secret",
  ]) {
    assert.throws(() => assertNoSensitiveMaterial(JSON.stringify({ value })), /forbidden material/);
  }
});

test("rejects mismatched report reconciliation", () => {
  const invalid = record("29481436126", "baseline", "2026-07-16T07:53:22.063Z", 288, "a".repeat(64));
  invalid.artifactScan.artifacts.report.sha256 = "c".repeat(64);
  assert.throws(() => buildPublicVendorAcceptance([invalid, record("29481517989", "stable", "2026-07-16T07:54:41.410Z", 269, "b".repeat(64), 2)]), /reconcile/);
});

test("checked-in public evidence remains anonymized and internally consistent", async () => {
  const raw = await readFile(new URL("../public-demo/vendor-sandbox-acceptance/report.json", import.meta.url), "utf8");
  assertNoSensitiveMaterial(raw);
  const report = JSON.parse(raw);
  assert.equal(report.schemaVersion, PUBLIC_VENDOR_ACCEPTANCE_SCHEMA);
  assert.deepEqual(report.summary, {
    totalRuns: 2,
    includedRuns: 2,
    passingRuns: 2,
    passRate: 1,
    regressions: 0,
    warnings: 0,
    redactionFindings: 0,
    artifactScanFindings: 0,
  });
  assert.equal(new Set(report.runs.map((run) => run.policySha256)).size, 1);
  assert.deepEqual(report.runs.map((run) => run.trend), ["baseline", "stable"]);
});

function record(runId, trend, startedAt, durationMs, reportSha256, totalRuns = 1) {
  const policySha256 = "f".repeat(64);
  return {
    history: {
      schemaVersion: "agentcert.vendor_acceptance_history.v0.1",
      kind: "agentcert.vendor_acceptance_history",
      generatedAt: startedAt,
      vendor: "stripe",
      environment: "sandbox",
      passed: true,
      trend,
      summary: { totalRuns, passingRuns: totalRuns, passRate: 1 },
      current: {
        externalId: `vendor-acceptance:stripe:${runId}:1`,
        startedAt,
        status: "passed",
        score: 100,
        schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
        policySha256,
        requestDurationMs: durationMs,
      },
    },
    redaction: {
      schemaVersion: "agentcert.vendor_redaction_scan.v0.1",
      kind: "agentcert.vendor_redaction_scan",
      passed: true,
      reportSchemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
      reportSha256,
      findings: [],
    },
    artifactScan: {
      schemaVersion: "agentcert.vendor_artifact_scan.v0.1",
      kind: "agentcert.vendor_artifact_scan",
      passed: true,
      findings: [],
      artifacts: { report: { sha256: reportSha256 } },
    },
  };
}
