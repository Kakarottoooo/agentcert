import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runProductionSmoke(options = {}) {
  const env = options.env ?? process.env;
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = required(env, "AGENTCERT_BASE_URL").replace(/\/$/, "");
  const projectId = required(env, "AGENTCERT_PROJECT_ID");
  const apiKey = required(env, "AGENTCERT_API_KEY");
  const requireShared = env.AGENTCERT_REQUIRE_SHARED_COORDINATION !== "false";
  const requireWebhookDelivery = env.AGENTCERT_REQUIRE_WEBHOOK_DELIVERY !== "false";
  const id = `production-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}-${randomBytes(3).toString("hex")}`;
  const auth = { authorization: `Bearer ${apiKey}` };
  const checks = [];

  const health = await json(requestFetch, `${baseUrl}/health`);
  check(health.ok === true, "health endpoint did not report ok");
  if (requireShared) check(health.coordination?.backend === "redis" && health.coordination?.shared === true && health.coordination?.state === "ready", "shared Redis coordination is not ready");
  checks.push("health");

  const envelope = {
    schemaVersion: "agentcert.envelope.v0.1",
    envelopeId: id,
    kind: "event",
    occurredAt: new Date().toISOString(),
    source: { agentId: "agentcert-production-smoke", agentVersion: "0.2", framework: "github-actions", adapter: "production-smoke" },
    run: { externalId: id, kind: "custom" },
    trace: { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), traceFlags: 1 },
    event: { sequence: 0, type: "production.smoke.started", actor: "ci", attributes: { source: "scheduled" } },
  };
  const envelopeUrl = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/envelopes`;
  const first = await json(requestFetch, envelopeUrl, {
    method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify(envelope),
  }, 202);
  const replayResponse = await requestFetch(envelopeUrl, {
    method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify(envelope),
  });
  check(replayResponse.status === 202 && replayResponse.headers.get("idempotency-replayed") === "true", "idempotent replay was not observable");
  const conflictResponse = await requestFetch(envelopeUrl, {
    method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": id },
    body: JSON.stringify({ ...envelope, occurredAt: new Date(Date.parse(envelope.occurredAt) + 1_000).toISOString() }),
  });
  check(conflictResponse.status === 409, `idempotency conflict returned ${conflictResponse.status}, expected 409`);
  checks.push("idempotency");

  const runId = first.run?.id;
  check(typeof runId === "string", "envelope response did not include a run ID");
  const evidenceBytes = Buffer.from(JSON.stringify({ schemaVersion: "agentcert.production_smoke.v0.1", id, runId, result: "passed" }));
  const evidenceUrl = new URL(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/evidence`);
  evidenceUrl.searchParams.set("fileName", `${id}.json`);
  evidenceUrl.searchParams.set("kind", "trace");
  evidenceUrl.searchParams.set("schemaVersion", "agentcert.production_smoke.v0.1");
  evidenceUrl.searchParams.set("runId", runId);
  const evidence = await json(requestFetch, evidenceUrl, {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: evidenceBytes,
  }, 201);
  check(evidence.sha256 === sha256(evidenceBytes) && evidence.sizeBytes === evidenceBytes.length, "stored evidence digest or size did not match uploaded bytes");
  const downloaded = await requestFetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(evidence.id)}/content`, { headers: auth });
  check(downloaded.ok && Buffer.from(await downloaded.arrayBuffer()).equals(evidenceBytes), "downloaded evidence bytes did not match the upload");
  checks.push("evidence-roundtrip");

  const attestation = evidence.metadata?.serverAttestation;
  const attestationPayload = evidence.metadata?.attestationPayload;
  check(attestation?.keyId && attestationPayload, "evidence did not include a server attestation");
  const signingKey = await json(requestFetch, `${baseUrl}/v1/signing-keys/${encodeURIComponent(attestation.keyId)}`);
  check(signingKey.status !== "revoked" && verifyAttestation(attestationPayload, attestation, signingKey.publicKeyPem), "server evidence signature did not verify");
  checks.push("signature-chain");

  await json(requestFetch, `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/complete`, {
    method: "POST", headers: { ...auth, "content-type": "application/json", "idempotency-key": `${id}:complete` },
    body: JSON.stringify({ status: "passed", score: 100, summary: "Scheduled production acceptance passed." }),
  }, 200);
  const operationsUrl = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/operations`;
  const operations = await waitForWebhookDelivery(requestFetch, operationsUrl, auth, runId, requireWebhookDelivery, options.sleep);
  if (requireShared) check(operations.status === "healthy", `Trust Operations reported ${operations.status} instead of healthy`);
  checks.push("run-completion", ...(requireWebhookDelivery ? ["webhook-delivery"] : []), "trust-operations");

  return {
    schemaVersion: "agentcert.production_smoke_result.v0.1",
    status: "passed",
    baseUrl,
    projectId,
    externalId: id,
    runId,
    evidenceId: evidence.id,
    signingKeyId: attestation.keyId,
    checks,
    completedAt: new Date().toISOString(),
  };
}

async function waitForWebhookDelivery(requestFetch, url, auth, eventId, required, sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))) {
  const attempts = required ? 30 : 1;
  let operations;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    operations = await json(requestFetch, url, { headers: auth });
    const job = operations.webhooks?.recentJobs?.find((item) => item.eventId === eventId && item.eventType === "run.completed");
    if (job?.status === "delivered") return operations;
    if (job?.status === "dead_letter") throw new Error(`production smoke webhook entered the dead-letter queue: ${job.lastError ?? "delivery exhausted"}`);
    if (!required) return operations;
    await sleep(1_000);
  }
  throw new Error("production smoke webhook was not delivered within 30 seconds; enable the AgentCert self-test receiver in Integrations");
}

async function json(requestFetch, url, init, expectedStatus = 200) {
  const response = await requestFetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${value.error ?? "unexpected response"}`);
  return value;
}

function verifyAttestation(payload, attestation, publicKeyPem) {
  if (attestation.schemaVersion !== "agentcert.server_attestation.v0.1" || attestation.algorithm !== "Ed25519") return false;
  const bytes = Buffer.from(canonicalJson(payload));
  if (sha256(bytes) !== attestation.payloadSha256) return false;
  try { return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(attestation.signature, "base64url")); }
  catch { return false; }
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function required(env, name) { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function check(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const output = resolve(process.env.AGENTCERT_SMOKE_OUTPUT ?? ".agentcert/production-smoke/result.json");
  try {
    const result = await runProductionSmoke();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = { schemaVersion: "agentcert.production_smoke_result.v0.1", status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
