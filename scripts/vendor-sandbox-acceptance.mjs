import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDOR_ACCEPTANCE_PREFIX = "vendor-acceptance:stripe:";
const REPORT_SCHEMA = "agentcert.sandbox_vendor_egress.v0.4";
const REPORT_KIND = "agentcert.sandbox_vendor_egress";
const DEFAULT_REPORT = ".agentcert/vendor-sandbox/current-report.json";
const DEFAULT_SCAN = ".agentcert/vendor-sandbox/redaction-scan.json";
const DEFAULT_HISTORY = ".agentcert/vendor-sandbox/history.json";
const DEFAULT_ARTIFACT_SCAN = ".agentcert/vendor-sandbox/artifact-scan.json";
const FORBIDDEN_FIELDS = new Set([
  "authorization",
  "headers",
  "apikey",
  "restrictedapikey",
  "secretkey",
  "clientsecret",
  "metadata",
  "rawresponse",
  "responsebody",
]);
const SECRET_PATTERNS = [
  { code: "stripe_key_pattern", pattern: /\b(?:rk|sk)_(?:test|live)_[A-Za-z0-9_]{8,}\b/ },
  { code: "agentcert_key_pattern", pattern: /\bac_live_[A-Za-z0-9_-]{8,}\b/ },
  { code: "authorization_value", pattern: /\bBearer\s+\S+/i },
  { code: "private_key_material", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export function scanVendorSandboxReport(report, rawText, secrets = {}) {
  const findings = new Set();
  if (!isRecord(report) || report.schemaVersion !== REPORT_SCHEMA || report.kind !== REPORT_KIND) {
    findings.add("invalid_report_contract");
  }
  if (report?.vendor !== "stripe" || report?.environment !== "sandbox") findings.add("invalid_vendor_boundary");
  if (report?.verdict?.passed !== true || report?.verdict?.score !== 100) findings.add("acceptance_not_passing");
  if (!Array.isArray(report?.audit) || !report.audit.some((entry) =>
    entry?.resource === "stripe.payment_intent.retrieve"
      && entry?.method === "GET"
      && entry?.origin === "https://api.stripe.com"
      && entry?.outcome === "allowed"
      && entry?.status >= 200
      && entry?.status < 300)) {
    findings.add("missing_successful_allowlisted_read");
  }
  const policy = report?.policy;
  if (!isRecord(policy)
    || JSON.stringify(policy.allowedOrigins) !== JSON.stringify(["https://api.stripe.com"])
    || JSON.stringify(policy.allowedMethods) !== JSON.stringify(["GET"])
    || !Array.isArray(policy.allowedResources)
    || !policy.allowedResources.includes("stripe.payment_intent.retrieve")) {
    findings.add("policy_allowlist_mismatch");
  }
  inspectFields(report, findings);
  for (const [label, value] of Object.entries(secrets)) {
    if (typeof value === "string" && value.length >= 8 && rawText.includes(value)) findings.add(`exact_secret:${safeLabel(label)}`);
  }
  for (const { code, pattern } of SECRET_PATTERNS) {
    if (pattern.test(rawText)) findings.add(code);
  }
  const reportSha256 = sha256(rawText);
  return {
    schemaVersion: "agentcert.vendor_redaction_scan.v0.1",
    kind: "agentcert.vendor_redaction_scan",
    scannedAt: new Date().toISOString(),
    reportSchemaVersion: typeof report?.schemaVersion === "string" ? report.schemaVersion : "unknown",
    reportSha256,
    passed: findings.size === 0,
    checks: {
      contract: !findings.has("invalid_report_contract"),
      vendorBoundary: !findings.has("invalid_vendor_boundary") && !findings.has("policy_allowlist_mismatch"),
      successfulRead: !findings.has("acceptance_not_passing") && !findings.has("missing_successful_allowlisted_read"),
      noSensitiveFields: ![...findings].some((item) => item.startsWith("forbidden_field:")),
      noSecretValues: ![...findings].some((item) => item.includes("secret") || item.includes("key_pattern") || item === "authorization_value" || item === "private_key_material"),
    },
    findings: [...findings].sort(),
  };
}

export function buildVendorAcceptanceHistory(report, runs, externalId) {
  const policySha256 = sha256(canonicalJson(report.policy));
  const currentFromStore = runs.find((run) => run.externalId === externalId);
  const current = currentFromStore ? summarizeRun(currentFromStore) : summarizeReport(report, externalId, policySha256);
  const historical = runs
    .filter((run) => typeof run.externalId === "string" && run.externalId.startsWith(VENDOR_ACCEPTANCE_PREFIX))
    .map(summarizeRun)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  if (!historical.some((run) => run.externalId === current.externalId)) historical.unshift(current);
  const previous = historical.find((run) => run.externalId !== current.externalId);
  const regressions = [];
  const warnings = [];
  if (current.status !== "passed") regressions.push("current_run_failed");
  if (previous) {
    if (current.score < previous.score) regressions.push("score_decreased");
    if (current.schemaVersion !== previous.schemaVersion) regressions.push("schema_changed");
    if (current.policySha256 && previous.policySha256 && current.policySha256 !== previous.policySha256) regressions.push("policy_changed");
    if (current.requestDurationMs !== undefined && previous.requestDurationMs !== undefined
      && current.requestDurationMs > previous.requestDurationMs * 2
      && current.requestDurationMs - previous.requestDurationMs > 500) {
      warnings.push("request_latency_increased");
    }
  }
  const trend = regressions.length > 0
    ? "regressed"
    : !previous
      ? "baseline"
      : previous.status !== "passed" && current.status === "passed"
        ? "recovered"
        : "stable";
  const passed = historical.filter((run) => run.status === "passed").length;
  return {
    schemaVersion: "agentcert.vendor_acceptance_history.v0.1",
    kind: "agentcert.vendor_acceptance_history",
    generatedAt: new Date().toISOString(),
    vendor: "stripe",
    environment: "sandbox",
    source: "agentcert_hosted_runs",
    trend,
    passed: regressions.length === 0 && current.status === "passed",
    regressions,
    warnings,
    summary: {
      totalRuns: historical.length,
      passingRuns: passed,
      passRate: historical.length ? passed / historical.length : 0,
    },
    current,
    previous: previous ?? null,
    runs: historical.slice(0, 20),
  };
}

export function scanAcceptanceArtifacts(artifacts, secrets = {}) {
  const findings = new Set();
  const reportRaw = artifacts.report ?? "";
  const scanRaw = artifacts.scan ?? "";
  let scan;
  try { scan = JSON.parse(scanRaw); } catch { findings.add("invalid_redaction_scan"); }
  if (scan?.passed !== true) findings.add("redaction_scan_not_passing");
  if (scan?.reportSha256 !== sha256(reportRaw)) findings.add("report_digest_mismatch");
  for (const [name, rawText] of Object.entries(artifacts)) {
    for (const [label, value] of Object.entries(secrets)) {
      if (typeof value === "string" && value.length >= 8 && rawText.includes(value)) {
        findings.add(`exact_secret:${safeLabel(label)}:${safeLabel(name)}`);
      }
    }
    for (const { code, pattern } of SECRET_PATTERNS) {
      if (pattern.test(rawText)) findings.add(`${code}:${safeLabel(name)}`);
    }
  }
  return {
    schemaVersion: "agentcert.vendor_artifact_scan.v0.1",
    kind: "agentcert.vendor_artifact_scan",
    scannedAt: new Date().toISOString(),
    passed: findings.size === 0,
    findings: [...findings].sort(),
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, rawText]) => [name, {
      bytes: Buffer.byteLength(rawText),
      sha256: sha256(rawText),
    }])),
  };
}

export async function fetchHostedRuns({ baseUrl, projectId, apiKey, fetch: requestFetch = fetch }) {
  const response = await requestFetch(`${baseUrl.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(projectId)}/runs`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`AgentCert hosted history request failed (${response.status}).`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.runs)) throw new Error("AgentCert hosted history response is invalid.");
  return payload.runs;
}

export async function runVendorAcceptance(command, options = {}) {
  const env = options.env ?? process.env;
  const reportPath = resolve(env.AGENTCERT_VENDOR_REPORT ?? DEFAULT_REPORT);
  const scanPath = resolve(env.AGENTCERT_VENDOR_SCAN ?? DEFAULT_SCAN);
  const historyPath = resolve(env.AGENTCERT_VENDOR_HISTORY ?? DEFAULT_HISTORY);
  const artifactScanPath = resolve(env.AGENTCERT_VENDOR_ARTIFACT_SCAN ?? DEFAULT_ARTIFACT_SCAN);
  const rawText = await readFile(reportPath, "utf8");
  const report = JSON.parse(rawText);
  if (command === "scan") {
    const scan = scanVendorSandboxReport(report, rawText, {
      stripe: env.STRIPE_RESTRICTED_TEST_KEY,
      agentcert: env.AGENTCERT_API_KEY,
    });
    await writeJson(scanPath, scan);
    process.stdout.write(`${scan.passed ? "PASS" : "FAIL"} vendor redaction scan (${scan.findings.length} findings)\n`);
    if (!scan.passed) throw new Error(`Vendor sandbox evidence failed redaction scan: ${scan.findings.join(", ")}.`);
    return scan;
  }
  if (command === "history") {
    const baseUrl = required(env.AGENTCERT_BASE_URL, "AGENTCERT_BASE_URL");
    const projectId = required(env.AGENTCERT_PROJECT_ID, "AGENTCERT_PROJECT_ID");
    const apiKey = required(env.AGENTCERT_API_KEY, "AGENTCERT_API_KEY");
    const externalId = required(env.AGENTCERT_VENDOR_EXTERNAL_ID, "AGENTCERT_VENDOR_EXTERNAL_ID");
    const runs = await fetchHostedRuns({ baseUrl, projectId, apiKey, fetch: options.fetch });
    const history = buildVendorAcceptanceHistory(report, runs, externalId);
    await writeJson(historyPath, history);
    process.stdout.write(`${history.passed ? "PASS" : "FAIL"} vendor acceptance history: ${history.trend}, ${history.summary.passingRuns}/${history.summary.totalRuns} passing\n`);
    if (!history.passed) throw new Error(`Vendor sandbox acceptance regressed: ${history.regressions.join(", ")}.`);
    return history;
  }
  if (command === "artifact-scan") {
    const artifacts = {
      report: rawText,
      scan: await readFile(scanPath, "utf8"),
    };
    try { artifacts.history = await readFile(historyPath, "utf8"); } catch { /* History request failures remain visible in the workflow verdict. */ }
    const artifactScan = scanAcceptanceArtifacts(artifacts, {
      stripe: env.STRIPE_RESTRICTED_TEST_KEY,
      agentcert: env.AGENTCERT_API_KEY,
    });
    await writeJson(artifactScanPath, artifactScan);
    process.stdout.write(`${artifactScan.passed ? "PASS" : "FAIL"} final vendor artifact scan (${artifactScan.findings.length} findings)\n`);
    if (!artifactScan.passed) throw new Error(`Vendor sandbox artifacts failed final scan: ${artifactScan.findings.join(", ")}.`);
    return artifactScan;
  }
  throw new Error("Usage: node scripts/vendor-sandbox-acceptance.mjs <scan|history|artifact-scan>");
}

function inspectFields(value, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry) => inspectFields(entry, findings));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (FORBIDDEN_FIELDS.has(normalized)) findings.add(`forbidden_field:${key}`);
    inspectFields(entry, findings);
  }
}

function summarizeRun(run) {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  return {
    externalId: String(run.externalId ?? "unknown"),
    startedAt: String(run.startedAt ?? run.completedAt ?? new Date(0).toISOString()),
    status: run.status === "passed" ? "passed" : "failed",
    score: normalizeScore(run.score),
    schemaVersion: String(run.schemaVersion ?? "unknown"),
    policySha256: typeof metadata.policySha256 === "string" ? metadata.policySha256 : undefined,
    requestDurationMs: finiteNumber(metadata.requestDurationMs),
  };
}

function summarizeReport(report, externalId, policySha256) {
  const allowedRequest = report.audit.find((entry) => entry?.outcome === "allowed");
  return {
    externalId,
    startedAt: report.generatedAt,
    status: report.verdict.passed ? "passed" : "failed",
    score: report.verdict.score,
    schemaVersion: report.schemaVersion,
    policySha256,
    requestDurationMs: finiteNumber(allowedRequest?.durationMs),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function normalizeScore(value) { const number = finiteNumber(value) ?? 0; return number <= 1 ? Math.round(number * 100) : Math.round(number); }
function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeLabel(value) { return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40); }
function required(value, name) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${name} is required.`); return text; }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runVendorAcceptance(process.argv[2]).catch((error) => {
    process.stderr.write(`Vendor acceptance error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
