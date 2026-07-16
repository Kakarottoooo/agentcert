import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_SMOKE_INCIDENT_TITLE = "[AgentCert] Production trust smoke failure";
const INCIDENT_MARKER = "<!-- agentcert-production-smoke-incident -->";

export async function upsertProductionSmokeIncident(options = {}) {
  const env = options.env ?? process.env;
  const requestFetch = options.fetch ?? fetch;
  const token = required(env, "GITHUB_TOKEN");
  const repository = required(env, "GITHUB_REPOSITORY");
  const runId = required(env, "GITHUB_RUN_ID");
  const apiBase = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${runId}`;
  const result = await readSmokeResult(env.AGENTCERT_SMOKE_OUTPUT, options.readFile ?? readFile);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  const query = encodeURIComponent(`repo:${repository} is:issue is:open in:title \"${PRODUCTION_SMOKE_INCIDENT_TITLE}\"`);
  const search = await githubJson(requestFetch, `${apiBase}/search/issues?q=${query}&per_page=100`, { headers });
  const existing = Array.isArray(search.items)
    ? search.items.find((item) => item.title === PRODUCTION_SMOKE_INCIDENT_TITLE && !item.pull_request)
    : undefined;
  const occurrence = incidentOccurrence(env, repository, runUrl, result);
  if (existing?.number) {
    await githubJson(requestFetch, `${apiBase}/repos/${repository}/issues/${existing.number}/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: occurrence }),
    }, 201);
    return { action: "commented", issueNumber: existing.number, issueUrl: existing.html_url };
  }
  const created = await githubJson(requestFetch, `${apiBase}/repos/${repository}/issues`, {
    method: "POST", headers, body: JSON.stringify({
      title: PRODUCTION_SMOKE_INCIDENT_TITLE,
      body: `${INCIDENT_MARKER}\n\nThe scheduled production assurance path failed. Repeated failures are appended to this issue instead of opening duplicates.\n\n${occurrence}`,
    }),
  }, 201);
  return { action: "created", issueNumber: created.number, issueUrl: created.html_url };
}

async function readSmokeResult(path, reader) {
  if (!path) return {};
  try { return JSON.parse(await reader(path, "utf8")); }
  catch { return {}; }
}

function incidentOccurrence(env, repository, runUrl, result) {
  const error = sanitize(result.error ?? "The workflow failed before a structured smoke error was recorded.");
  const completedAt = sanitize(result.completedAt ?? new Date().toISOString());
  const sha = sanitize(env.GITHUB_SHA ?? "unknown");
  const attempt = sanitize(env.GITHUB_RUN_ATTEMPT ?? "1");
  return [
    "### Failure occurrence",
    `- Workflow run: [${sanitize(env.GITHUB_RUN_ID)} (attempt ${attempt})](${runUrl})`,
    `- Commit: \`${sha}\``,
    `- Recorded: ${completedAt}`,
    `- Error: ${error}`,
    "",
    `Follow the [Trust Operations incident runbook](https://github.com/${repository}/blob/main/docs/trust-operations-runbook.md) before closing this issue.`,
  ].join("\n");
}

async function githubJson(requestFetch, url, init, expectedStatus = 200) {
  const response = await requestFetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) throw new Error(`GitHub API returned ${response.status}: ${sanitize(value.message ?? "unexpected response")}`);
  return value;
}

function sanitize(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/`/g, "'").trim().slice(0, 1_000);
}
function required(env, name) { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }

async function main() {
  const result = await upsertProductionSmokeIncident();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
