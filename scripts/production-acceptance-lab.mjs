import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.env.AGENTCERT_ACCEPTANCE_OUTPUT ?? ".agentcert/acceptance/production-acceptance.json");
const startedAt = new Date().toISOString();
const checks = [];

await check("control-plane-build", "npm", ["--prefix", "packages/agentcert-control-plane", "run", "build"]);
await check("tenant-isolation-stress", "npm", ["--prefix", "packages/agentcert-control-plane", "exec", "--", "vitest", "run", "tests/tenant-isolation.stress.test.ts"]);
await check("api-fuzz-postgres-redis-recovery", "npm", ["--prefix", "packages/agentcert-control-plane", "exec", "--", "vitest", "run", "tests/production-acceptance-lab.test.ts"]);
await check("concurrent-idempotency-and-rate-limits", "npm", ["--prefix", "packages/agentcert-control-plane", "exec", "--", "vitest", "run", "tests/production-security.test.ts", "tests/universal-assurance.test.ts"]);
await check("webhook-failure-retry-and-dlq", "npm", ["--prefix", "packages/agentcert-control-plane", "exec", "--", "vitest", "run", "tests/trust-operations.test.ts"]);
await check("assurance-lifecycle", "npm", ["--prefix", "packages/agentcert-control-plane", "exec", "--", "vitest", "run", "tests/assurance-lifecycle.test.ts"]);
await check("cli-compatibility-suite", "npm", ["--prefix", "packages/agentcert-cli", "test"]);

const payload = {
  schemaVersion: "agentcert.production_acceptance_report.v0.1",
  status: checks.every((item) => item.status === "passed") ? "passed" : "failed",
  startedAt,
  completedAt: new Date().toISOString(),
  environment: {
    ci: Boolean(process.env.CI),
    postgres: Boolean(process.env.AGENTCERT_ACCEPTANCE_DATABASE_URL),
    redis: Boolean(process.env.AGENTCERT_ACCEPTANCE_REDIS_URL),
    node: process.version,
  },
  checks,
  statement: "This report records repeatable engineering acceptance checks. It is not a regulatory certification or a guarantee of future availability.",
};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const bytes = Buffer.from(canonicalJson(payload));
const report = {
  ...payload,
  localAttestation: {
    schemaVersion: "agentcert.local_acceptance_attestation.v0.1",
    algorithm: "Ed25519",
    payloadSha256: sha256(bytes),
    signature: sign(null, bytes, privateKey).toString("base64url"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
};
if (!verify(null, bytes, publicKey, Buffer.from(report.localAttestation.signature, "base64url"))) throw new Error("Local acceptance signature self-verification failed.");
await mkdir(dirname(output), { recursive: true });
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
await writeFile(output, reportBytes);
const hosted = hostedConfiguration();
if (hosted) {
  await checkTask("hosted-signed-report-storage", async () => {
    const url = new URL(`${hosted.baseUrl}/v1/projects/${encodeURIComponent(hosted.projectId)}/evidence`);
    url.searchParams.set("fileName", `production-acceptance-${new Date().toISOString().slice(0, 10)}.json`);
    url.searchParams.set("kind", "production_acceptance");
    url.searchParams.set("schemaVersion", payload.schemaVersion);
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${hosted.apiKey}`, "content-type": "application/json" }, body: reportBytes });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Hosted report upload failed (${response.status}): ${value.error ?? "unknown error"}`);
    if (value.sha256 !== sha256(reportBytes) || !value.metadata?.serverAttestation) throw new Error("Hosted report receipt did not preserve bytes and server attestation.");
    const receipt = { schemaVersion: "agentcert.production_acceptance_receipt.v0.1", evidenceId: value.id, sha256: value.sha256, keyId: value.metadata.serverAttestation.keyId, storedAt: value.createdAt };
    await writeFile(`${output}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return `Evidence ${value.id} stored with server key ${receipt.keyId}.`;
  });
}
const finalStatus = checks.every((item) => item.status === "passed") ? "passed" : "failed";
process.stdout.write(`Production acceptance ${finalStatus}. Report: ${output}\n`);
if (finalStatus !== "passed") process.exitCode = 1;

async function check(id, command, args) {
  return checkTask(id, () => run(command, args));
}
async function checkTask(id, task) {
  const began = Date.now();
  try {
    const result = await task();
    checks.push({ id, status: "passed", durationMs: Date.now() - began, summary: tail(result, 600) });
  } catch (error) {
    checks.push({ id, status: "failed", durationMs: Date.now() - began, summary: tail(error instanceof Error ? error.message : String(error), 1_000) });
  }
}
function hostedConfiguration() {
  const baseUrl = process.env.AGENTCERT_BASE_URL;
  const projectId = process.env.AGENTCERT_PROJECT_ID;
  const apiKey = process.env.AGENTCERT_API_KEY;
  if (!baseUrl && !projectId && !apiKey) return undefined;
  if (!baseUrl || !projectId || !apiKey) throw new Error("Hosted acceptance upload requires AGENTCERT_BASE_URL, AGENTCERT_PROJECT_ID, and AGENTCERT_API_KEY together.");
  return { baseUrl: baseUrl.replace(/\/$/, ""), projectId, apiKey };
}
function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: process.platform === "win32", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited ${code}: ${tail(output, 2_000)}`)));
  });
}
function tail(value, limit) { return value.length <= limit ? value : value.slice(-limit); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
