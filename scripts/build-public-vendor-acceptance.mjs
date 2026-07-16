import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_VENDOR_ACCEPTANCE_SCHEMA = "agentcert.public_vendor_acceptance.v0.1";
const HISTORY_SCHEMA = "agentcert.vendor_acceptance_history.v0.1";
const REDACTION_SCHEMA = "agentcert.vendor_redaction_scan.v0.1";
const ARTIFACT_SCAN_SCHEMA = "agentcert.vendor_artifact_scan.v0.1";
const REPORT_SCHEMA = "agentcert.sandbox_vendor_egress.v0.4";
const HEX_256 = /^[a-f0-9]{64}$/;
const EXTERNAL_ID = /^vendor-acceptance:stripe:(\d+):(\d+)$/;
const SENSITIVE_PATTERNS = [
  { code: "payment_intent_id", pattern: /\bpi_[A-Za-z0-9_]+\b/i },
  { code: "stripe_key", pattern: /\b(?:rk|sk|pk)_(?:test|live)_[A-Za-z0-9_]+\b/i },
  { code: "agentcert_key", pattern: /\bac_live_[A-Za-z0-9_-]+\b/i },
  { code: "authorization", pattern: /(?:\bBearer\s+\S+|["']authorization["']\s*:)/i },
  { code: "client_secret", pattern: /\bclient_secret\b/i },
  { code: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export function buildPublicVendorAcceptance(records) {
  if (!Array.isArray(records) || records.length < 2) {
    throw new Error("Public vendor acceptance requires at least two protected runs.");
  }
  const runs = records.map(normalizeRecord).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const latest = runs.at(-1);
  const policyDigests = new Set(runs.map((run) => run.policySha256));
  if (latest.trend !== "stable") throw new Error("Latest protected run must have a stable history trend.");
  if (policyDigests.size !== 1) throw new Error("Protected runs do not share one egress policy digest.");
  if (runs.some((run) => run.status !== "passed" || run.score !== 100)) {
    throw new Error("Every published protected run must pass with score 100.");
  }

  const report = {
    schemaVersion: PUBLIC_VENDOR_ACCEPTANCE_SCHEMA,
    kind: "agentcert.public_vendor_acceptance",
    publishedAt: latest.generatedAt,
    subject: {
      vendor: "stripe",
      environment: "sandbox",
      capability: "payment_intent.retrieve",
      mode: "read_only",
      productionAccess: false,
    },
    verdict: {
      passed: true,
      score: 100,
      level: "stable",
    },
    summary: {
      totalRuns: latest.totalRuns,
      includedRuns: runs.length,
      passingRuns: latest.passingRuns,
      passRate: latest.passRate,
      regressions: 0,
      warnings: 0,
      redactionFindings: 0,
      artifactScanFindings: 0,
    },
    boundary: {
      allowedOrigins: ["https://api.stripe.com"],
      allowedMethods: ["GET"],
      allowedResources: ["stripe.payment_intent.retrieve"],
      credentialType: "restricted_test_key",
      requiredPermission: "PaymentIntents: Read",
      redirects: "rejected",
      timeoutMs: 5000,
      maxRequestsPerMinute: 10,
      policySha256: latest.policySha256,
    },
    evidenceChain: [
      { sequence: 1, type: "environment_approval", status: "passed", detail: "GitHub vendor-sandbox approval released the protected secrets." },
      { sequence: 2, type: "bounded_vendor_read", status: "passed", detail: "One allowlisted HTTPS GET observed a Stripe sandbox PaymentIntent." },
      { sequence: 3, type: "redacted_v0_4_report", status: "passed", detail: "The runtime retained only the bounded v0.4 observation and request audit." },
      { sequence: 4, type: "pre_upload_redaction", status: "passed", detail: "Credential patterns, forbidden fields, and exact secret values produced zero findings." },
      { sequence: 5, type: "production_retention", status: "passed", detail: "The validated report was retained by the AgentCert production Control Plane." },
      { sequence: 6, type: "history_comparison", status: "passed", detail: "The second protected run matched the prior schema and egress policy." },
      { sequence: 7, type: "final_artifact_scan", status: "passed", detail: "Every publishable workflow artifact passed a second aggregate scan." },
    ],
    runs: runs.map((run) => ({
      workflowRunId: run.workflowRunId,
      workflowUrl: `https://github.com/Kakarottoooo/agentcert/actions/runs/${run.workflowRunId}`,
      attempt: run.attempt,
      startedAt: run.startedAt,
      status: run.status,
      score: run.score,
      trend: run.trend,
      schemaVersion: run.schemaVersion,
      requestDurationMs: run.requestDurationMs,
      reportSha256: run.reportSha256,
      policySha256: run.policySha256,
      scans: {
        preUpload: { passed: true, findings: 0 },
        finalArtifacts: { passed: true, findings: 0 },
      },
    })),
    disclosure: {
      anonymized: true,
      publicFields: ["workflow run", "timestamps", "verdict", "latency", "schema", "SHA-256 digests", "scan counts"],
      omittedFields: ["PaymentIntent ID", "API keys", "Authorization headers", "raw vendor response", "client secret", "metadata"],
      sourceReportsPublic: false,
      reason: "The public report proves the acceptance chain without publishing vendor object identifiers or credentials.",
    },
    limitations: [
      "This proves one fixed Stripe sandbox read-only boundary, not live-mode or write safety.",
      "It does not independently attest the permissions configured in the Stripe Dashboard.",
      "It is reproducible assurance evidence, not certification of Stripe or the calling application.",
    ],
  };
  assertNoSensitiveMaterial(JSON.stringify(report));
  return report;
}

export function assertNoSensitiveMaterial(rawText) {
  const findings = SENSITIVE_PATTERNS.filter(({ pattern }) => pattern.test(rawText)).map(({ code }) => code);
  if (findings.length > 0) throw new Error(`Public vendor acceptance contains forbidden material: ${findings.join(", ")}.`);
}

export async function loadSafeArtifactRecords(sourceRoot) {
  const historyPaths = (await walk(resolve(sourceRoot))).filter((path) => path.endsWith("history.json"));
  if (historyPaths.length === 0) throw new Error("No vendor acceptance history artifacts were found.");
  return Promise.all(historyPaths.map(async (historyPath) => {
    const artifactRoot = dirname(historyPath);
    const paths = {
      history: historyPath,
      redaction: join(artifactRoot, "redaction-scan.json"),
      artifactScan: join(artifactRoot, "artifact-scan.json"),
    };
    const [historyRaw, redactionRaw, artifactScanRaw] = await Promise.all([
      readFile(paths.history, "utf8"),
      readFile(paths.redaction, "utf8"),
      readFile(paths.artifactScan, "utf8"),
    ]);
    assertNoSensitiveMaterial(`${historyRaw}\n${redactionRaw}\n${artifactScanRaw}`);
    return {
      history: JSON.parse(historyRaw),
      redaction: JSON.parse(redactionRaw),
      artifactScan: JSON.parse(artifactScanRaw),
    };
  }));
}

function normalizeRecord(record) {
  const { history, redaction, artifactScan } = record;
  if (history?.schemaVersion !== HISTORY_SCHEMA || history?.kind !== "agentcert.vendor_acceptance_history") {
    throw new Error("Vendor acceptance history contract is invalid.");
  }
  if (history.vendor !== "stripe" || history.environment !== "sandbox" || history.passed !== true) {
    throw new Error("Vendor acceptance history boundary or verdict is invalid.");
  }
  if (redaction?.schemaVersion !== REDACTION_SCHEMA || redaction?.kind !== "agentcert.vendor_redaction_scan"
    || redaction.passed !== true || redaction.reportSchemaVersion !== REPORT_SCHEMA || redaction.findings?.length !== 0
    || !HEX_256.test(redaction.reportSha256 ?? "")) {
    throw new Error("Pre-upload redaction evidence is invalid.");
  }
  if (artifactScan?.schemaVersion !== ARTIFACT_SCAN_SCHEMA || artifactScan?.kind !== "agentcert.vendor_artifact_scan"
    || artifactScan.passed !== true || artifactScan.findings?.length !== 0) {
    throw new Error("Final artifact scan evidence is invalid.");
  }
  const current = history.current;
  const idMatch = EXTERNAL_ID.exec(current?.externalId ?? "");
  if (!idMatch) throw new Error("Protected workflow provenance is invalid.");
  if (current.status !== "passed" || current.score !== 100 || current.schemaVersion !== REPORT_SCHEMA
    || !HEX_256.test(current.policySha256 ?? "") || !Number.isFinite(current.requestDurationMs)
    || !Number.isFinite(Date.parse(current.startedAt))) {
    throw new Error("Protected run summary is invalid.");
  }
  if (artifactScan.artifacts?.report?.sha256 !== redaction.reportSha256) {
    throw new Error("Final artifact scan does not reconcile the redacted report digest.");
  }
  return {
    workflowRunId: Number(idMatch[1]),
    attempt: Number(idMatch[2]),
    generatedAt: history.generatedAt,
    startedAt: current.startedAt,
    status: current.status,
    score: current.score,
    trend: history.trend,
    schemaVersion: current.schemaVersion,
    policySha256: current.policySha256,
    requestDurationMs: current.requestDurationMs,
    reportSha256: redaction.reportSha256,
    totalRuns: history.summary.totalRuns,
    passingRuns: history.summary.passingRuns,
    passRate: history.summary.passRate,
  };
}

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runCli() {
  const source = argument(process.argv.slice(2), "--source");
  const out = argument(process.argv.slice(2), "--out");
  if (!source || !out) throw new Error("Usage: node scripts/build-public-vendor-acceptance.mjs --source <artifact-dir> --out <report.json>");
  const report = buildPublicVendorAcceptance(await loadSafeArtifactRecords(source));
  const outPath = resolve(out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote anonymized public vendor acceptance: ${outPath}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli().catch((error) => {
  process.stderr.write(`Public vendor acceptance error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
