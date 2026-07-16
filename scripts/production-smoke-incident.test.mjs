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

function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
