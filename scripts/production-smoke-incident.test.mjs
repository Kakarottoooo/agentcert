import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_SMOKE_INCIDENT_TITLE, upsertProductionSmokeIncident } from "./production-smoke-incident.mjs";

const env = {
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "Kakarottoooo/agentcert",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SHA: "abc123",
  AGENTCERT_SMOKE_OUTPUT: "result.json",
};
const readFile = async () => JSON.stringify({ status: "failed", error: "Redis coordination is unavailable", completedAt: "2026-07-15T08:00:00.000Z" });

test("creates the production incident when no matching issue is open", async () => {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/search/issues")) return response({ items: [] });
    return response({ number: 42, html_url: "https://github.com/Kakarottoooo/agentcert/issues/42" }, 201);
  };
  const result = await upsertProductionSmokeIncident({ env, fetch: fetchMock, readFile });
  assert.deepEqual(result, { action: "created", issueNumber: 42, issueUrl: "https://github.com/Kakarottoooo/agentcert/issues/42" });
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.title, PRODUCTION_SMOKE_INCIDENT_TITLE);
  assert.match(body.body, /Redis coordination is unavailable/);
  assert.match(body.body, /actions\/runs\/123/);
});

test("comments on the existing incident instead of creating a duplicate", async () => {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/search/issues")) return response({ items: [{ number: 7, title: PRODUCTION_SMOKE_INCIDENT_TITLE, html_url: "https://github.com/x/issues/7" }] });
    return response({ id: 99 }, 201);
  };
  const result = await upsertProductionSmokeIncident({ env, fetch: fetchMock, readFile });
  assert.equal(result.action, "commented");
  assert.match(calls[1].url, /issues\/7\/comments$/);
  assert.equal(calls.length, 2);
});

test("appends recovery evidence without closing the GitHub incident", async () => {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/search/issues")) return response({ items: [{ number: 7, title: PRODUCTION_SMOKE_INCIDENT_TITLE, html_url: "https://github.com/x/issues/7" }] });
    return response({ id: 100 }, 201);
  };
  const recovery = async () => JSON.stringify({
    status: "passed", completedAt: "2026-07-15T09:00:00.000Z",
    operationalIncident: { id: "incident-1", status: "recovered" },
    incidentTransition: { toStatus: "recovered", reason: "Two consecutive production smoke runs passed.", evidence: { consecutivePasses: 2 } },
  });
  const result = await upsertProductionSmokeIncident({ env: { ...env, AGENTCERT_SMOKE_OUTCOME: "success" }, fetch: fetchMock, readFile: recovery });
  assert.equal(result.action, "recovery_commented");
  assert.equal(calls.length, 2);
  assert.match(JSON.parse(calls[1].init.body).body, /Consecutive passing smokes: 2/);
});

test("closes only after the AgentCert incident is explicitly resolved", async () => {
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/search/issues")) return response({ items: [{ number: 7, title: PRODUCTION_SMOKE_INCIDENT_TITLE, html_url: "https://github.com/x/issues/7" }] });
    if (init.method === "POST") return response({ id: 101 }, 201);
    return response({ number: 7, state: "closed" });
  };
  const resolved = async () => JSON.stringify({
    status: "passed", completedAt: "2026-07-15T10:00:00.000Z",
    operationalIncident: { id: "incident-1", status: "resolved", resolvedByEmail: "owner@example.com", resolvedAt: "2026-07-15T09:30:00.000Z" },
  });
  const result = await upsertProductionSmokeIncident({ env: { ...env, AGENTCERT_SMOKE_OUTCOME: "success" }, fetch: fetchMock, readFile: resolved });
  assert.equal(result.action, "closed");
  assert.equal(calls[2].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[2].init.body), { state: "closed", state_reason: "completed" });
});

function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
