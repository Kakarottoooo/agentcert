import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { runProductionSmoke } from "./production-smoke.mjs";

test("production smoke verifies the complete hosted trust path", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  let envelopeCalls = 0;
  let evidenceBytes = Buffer.alloc(0);
  let evidence;
  const fetchMock = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") return response({ ok: true, coordination: { backend: "redis", state: "ready", shared: true } });
    if (url.pathname.endsWith("/envelopes")) {
      envelopeCalls += 1;
      if (envelopeCalls === 3) return response({ error: "conflict" }, 409);
      return response({ run: { id: "run-1" } }, 202, envelopeCalls === 2 ? { "idempotency-replayed": "true" } : {});
    }
    if (url.pathname.endsWith("/evidence") && init.method === "POST") {
      evidenceBytes = Buffer.from(init.body);
      const payload = { evidenceId: "evidence-1", projectId: "project-1", runId: "run-1", kind: "trace", schemaVersion: "agentcert.production_smoke.v0.1", sha256: sha256(evidenceBytes), sizeBytes: evidenceBytes.length, createdAt: "2026-07-15T00:00:00.000Z" };
      const canonical = canonicalJson(payload);
      evidence = { id: "evidence-1", sha256: payload.sha256, sizeBytes: payload.sizeBytes, metadata: { attestationPayload: payload, serverAttestation: {
        schemaVersion: "agentcert.server_attestation.v0.1", algorithm: "Ed25519", keyId: "key-old", signedAt: "2026-07-15T00:00:01.000Z",
        payloadSha256: sha256(Buffer.from(canonical)), signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
      } } };
      return response(evidence, 201);
    }
    if (url.pathname.endsWith("/evidence/evidence-1/content")) return new Response(evidenceBytes, { status: 200 });
    if (url.pathname === "/v1/signing-keys/key-old") return response({ keyId: "key-old", algorithm: "Ed25519", publicKeyPem, status: "retired" });
    if (url.pathname.endsWith("/runs/run-1/complete")) return response({ id: "run-1", status: "passed" });
    if (url.pathname.endsWith("/operations/smoke-runs")) return response({ id: "sample-1", status: "passed" }, 201);
    if (url.pathname.endsWith("/operations")) return response({ status: "healthy", webhooks: { recentJobs: [{ eventId: "run-1", eventType: "run.completed", status: "delivered" }] } });
    return response({ error: `unhandled ${url.pathname}` }, 404);
  };

  const result = await runProductionSmoke({
    env: { AGENTCERT_BASE_URL: "https://agentcert.example", AGENTCERT_PROJECT_ID: "project-1", AGENTCERT_API_KEY: "secret" },
    fetch: fetchMock,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.checks, ["health", "idempotency", "evidence-roundtrip", "signature-chain", "run-completion", "webhook-delivery", "health-history", "trust-operations"]);
});

test("production smoke records a failed health sample without hiding the original error", async () => {
  let recorded;
  const fetchMock = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") return response({ ok: false });
    if (url.pathname.endsWith("/operations/smoke-runs")) {
      recorded = JSON.parse(init.body);
      return response({ id: "sample-failed" }, 201);
    }
    return response({ error: `unhandled ${url.pathname}` }, 404);
  };
  await assert.rejects(runProductionSmoke({
    env: { AGENTCERT_BASE_URL: "https://agentcert.example", AGENTCERT_PROJECT_ID: "project-1", AGENTCERT_API_KEY: "secret" },
    fetch: fetchMock,
  }), /health endpoint did not report ok/);
  assert.equal(recorded.status, "failed");
  assert.match(recorded.error, /health endpoint did not report ok/);
});

function response(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } }); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
