import assert from "node:assert/strict";
import test from "node:test";
import {
  VENDOR_ACCEPTANCE_PREFIX,
  buildVendorAcceptanceHistory,
  fetchHostedRuns,
  scanAcceptanceArtifacts,
  scanVendorSandboxReport,
} from "./vendor-sandbox-acceptance.mjs";

test("secondary scan accepts only a passing redacted v0.4 Stripe report", () => {
  const report = passingReport();
  const raw = JSON.stringify(report);
  const scan = scanVendorSandboxReport(report, raw, {
    stripe: "rk_test_secret_not_present_123",
    agentcert: "ac_live_secret_not_present_123",
  });

  assert.equal(scan.passed, true);
  assert.deepEqual(scan.findings, []);
  assert.equal(scan.checks.noSensitiveFields, true);
  assert.equal(scan.checks.noSecretValues, true);
});

test("secondary scan reports leak classes without echoing secret values", () => {
  const secret = "rk_test_leaked_value_123456";
  const report = { ...passingReport(), authorization: `Bearer ${secret}` };
  const raw = JSON.stringify(report);
  const scan = scanVendorSandboxReport(report, raw, { stripe: secret });

  assert.equal(scan.passed, false);
  assert.ok(scan.findings.includes("forbidden_field:authorization"));
  assert.ok(scan.findings.includes("exact_secret:stripe"));
  assert.ok(scan.findings.includes("stripe_key_pattern"));
  assert.equal(JSON.stringify(scan).includes(secret), false);
});

test("history compares the current hosted acceptance with the previous real run", () => {
  const report = passingReport();
  const history = buildVendorAcceptanceHistory(report, [
    hostedRun("2", "passed", 1, "2030-01-02T00:00:00.000Z", "policy-new", 900),
    hostedRun("1", "passed", 1, "2030-01-01T00:00:00.000Z", "policy-old", 100),
  ], `${VENDOR_ACCEPTANCE_PREFIX}2`);

  assert.equal(history.trend, "regressed");
  assert.equal(history.passed, false);
  assert.ok(history.regressions.includes("policy_changed"));
  assert.ok(history.warnings.includes("request_latency_increased"));
  assert.equal(history.summary.totalRuns, 2);
});

test("history marks a passing first run as a baseline", () => {
  const report = passingReport();
  const externalId = `${VENDOR_ACCEPTANCE_PREFIX}first`;
  const history = buildVendorAcceptanceHistory(report, [
    hostedRun("first", "passed", 1, "2030-01-01T00:00:00.000Z", undefined, 120),
  ], externalId);

  assert.equal(history.trend, "baseline");
  assert.equal(history.passed, true);
  assert.equal(history.previous, null);
});

test("hosted history request uses authorization without exposing it in errors", async () => {
  const requestFetch = async (url, init) => {
    assert.equal(url, "https://agentcert.example/v1/projects/project-1/runs");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer ac_live_history_secret");
    return Response.json({ runs: [hostedRun("1", "passed", 1, "2030-01-01T00:00:00.000Z")] });
  };
  const runs = await fetchHostedRuns({
    baseUrl: "https://agentcert.example/",
    projectId: "project-1",
    apiKey: "ac_live_history_secret",
    fetch: requestFetch,
  });
  assert.equal(runs.length, 1);

  const failure = fetchHostedRuns({
    baseUrl: "https://agentcert.example",
    projectId: "project-1",
    apiKey: "ac_live_must_not_leak",
    fetch: async () => Response.json({ error: "credential ac_live_must_not_leak" }, { status: 403 }),
  });
  await assert.rejects(failure, (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /ac_live_must_not_leak/);
    return true;
  });
});

test("final artifact scan verifies the report digest and all retained files", () => {
  const raw = JSON.stringify(passingReport());
  const scan = scanVendorSandboxReport(passingReport(), raw, {});
  const result = scanAcceptanceArtifacts({
    report: raw,
    scan: JSON.stringify(scan),
    history: JSON.stringify({ passed: true, trend: "baseline" }),
  });

  assert.equal(result.passed, true);
  assert.deepEqual(Object.keys(result.artifacts), ["report", "scan", "history"]);
});

test("final artifact scan blocks a leaked secret without retaining its value", () => {
  const secret = "rk_test_secondary_scan_secret_123456";
  const raw = JSON.stringify(passingReport());
  const scan = scanVendorSandboxReport(passingReport(), raw, {});
  const result = scanAcceptanceArtifacts({
    report: raw,
    scan: JSON.stringify(scan),
    history: JSON.stringify({ note: secret }),
  }, { stripe: secret });

  assert.equal(result.passed, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

function passingReport() {
  return {
    schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
    kind: "agentcert.sandbox_vendor_egress",
    implementation: "stripe-payment-intent-readonly",
    vendor: "stripe",
    environment: "sandbox",
    generatedAt: "2030-01-02T00:00:00.000Z",
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
    audit: [{
      requestId: "stripe-1",
      timestamp: "2030-01-02T00:00:00.000Z",
      vendor: "stripe",
      resource: "stripe.payment_intent.retrieve",
      method: "GET",
      origin: "https://api.stripe.com",
      outcome: "allowed",
      durationMs: 120,
      status: 200,
    }],
    observation: { id: "pi_12345678", object: "payment_intent", livemode: false },
    disclaimer: "Sandbox only.",
  };
}

function hostedRun(id, status, score, startedAt, policySha256, requestDurationMs) {
  return {
    id: `run-${id}`,
    externalId: `${VENDOR_ACCEPTANCE_PREFIX}${id}`,
    status,
    score,
    schemaVersion: "agentcert.sandbox_vendor_egress.v0.4",
    startedAt,
    metadata: {
      evidenceType: "agentcert.sandbox_vendor_egress",
      vendor: "stripe",
      environment: "sandbox",
      ...(policySha256 ? { policySha256 } : {}),
      ...(requestDurationMs === undefined ? {} : { requestDurationMs }),
    },
  };
}
