import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "agentcert-external-e2e-"));
let server;

try {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [resolve(root, "packages/agentcert-control-plane/dist/cli.js")], {
    cwd: temp,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), AGENTCERT_DEV_MODE: "true", AGENTCERT_PUBLIC_URL: baseUrl,
      AGENTCERT_DASHBOARD_DIR: resolve(root, "public-demo/agentcert-monitor") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });
  await waitForHealth(baseUrl, server, () => serverLog);

  const human = { authorization: "Bearer dev-local-token", "content-type": "application/json" };
  const bootstrap = await jsonRequest(`${baseUrl}/v1/onboarding/bootstrap`, { method: "POST", headers: human });
  const created = await jsonRequest(`${baseUrl}/v1/projects`, { method: "POST", headers: human, body: JSON.stringify({ name: "External smoke" }) });
  const project = await jsonRequest(`${baseUrl}/v1/projects/${created.id}`, { method: "PATCH", headers: human, body: JSON.stringify({ name: "External onboarding smoke" }) });
  if (project.slug !== "external-smoke") throw new Error("Project rename changed the stable slug.");
  const key = await jsonRequest(`${baseUrl}/v1/projects/${project.id}/api-keys`, { method: "POST", headers: human, body: JSON.stringify({ name: "External E2E" }) });

  const packOutput = await run(npmCommand(), ["pack", "--json", "--pack-destination", temp], resolve(root, "packages/agentcert-cli"));
  const packed = JSON.parse(packOutput).at(0)?.filename;
  if (!packed) throw new Error(`npm pack did not return a tarball: ${packOutput}`);
  const tarball = join(temp, basename(packed));
  await run(npmCommand(), ["init", "-y"], temp);
  await run(npmCommand(), ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", tarball], temp);
  const agentcert = process.platform === "win32" ? join(temp, "node_modules/.bin/agentcert.cmd") : join(temp, "node_modules/.bin/agentcert");
  await run(agentcert, ["init", "--template", "browser", "--subject", "external-smoke"], temp);
  for (const template of ["coding", "mcp", "workflow", "data"]) {
    const templateDir = join(temp, `template-${template}`);
    await mkdir(templateDir);
    await run(agentcert, ["init", "--template", template, "--subject", `external-${template}`], templateDir);
    const config = JSON.parse(await readFile(join(templateDir, "agentcert.config.json"), "utf8"));
    if (config.subject.name !== `external-${template}`) throw new Error(`${template} template wrote the wrong subject.`);
    if (template !== "mcp") await run(process.execPath, ["--check", "agentcert.adapter.mjs"], templateDir);
  }

  const fixture = resolve(root, "public-demo/browser-agent-robustness/evidence/tripwire-public-demo/tripwire-result.json");
  await readFile(fixture);
  const localFixture = join(temp, "tripwire-result.json");
  await copyFile(fixture, localFixture);
  await run(agentcert, ["run", "--tripwire", "tripwire-result.json", "--subject", "external-smoke", "--push", "--no-artifacts"], temp, {
    AGENTCERT_BASE_URL: baseUrl, AGENTCERT_PROJECT_ID: project.id, AGENTCERT_API_KEY: key.secret,
  });

  const onboarding = await jsonRequest(`${baseUrl}/v1/projects/${project.id}/onboarding`, { headers: human });
  const overview = await jsonRequest(`${baseUrl}/v1/projects/${project.id}/overview`, { headers: human });
  const defaultOverview = await jsonRequest(`${baseUrl}/v1/projects/${bootstrap.project.id}/overview`, { headers: human });
  const dashboard = await fetch(baseUrl).then((response) => response.text());
  if (!onboarding.complete || onboarding.completedSteps !== 3) throw new Error("Hosted onboarding did not reach 3/3.");
  if (overview.summary.runs < 1 || overview.summary.evidence < 1) throw new Error("Target project did not receive the external evidence.");
  if (defaultOverview.summary.runs !== 0 || defaultOverview.summary.evidence !== 0) throw new Error("Evidence leaked into the bootstrap project.");
  if (!dashboard.includes("id=\"root\"")) throw new Error("Hosted Dashboard was not served.");

  process.stdout.write(`${JSON.stringify({ ok: true, source: "empty-repository", templatesVerified: ["browser", "coding", "mcp", "workflow", "data"], projectId: project.id,
    onboarding: `${onboarding.completedSteps}/${onboarding.totalSteps}`, runs: overview.summary.runs,
    evidence: overview.summary.evidence, isolatedFromProject: bootstrap.project.id }, null, 2)}\n`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
    process.stderr.write(`Temporary E2E directory cleanup deferred: ${error.message}\n`);
  });
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed (${response.status}): ${value.error ?? "unknown error"}`);
  return value;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Control plane exited early (${child.exitCode}).\n${logs()}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Control plane did not become healthy.\n${logs()}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      listener.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const shell = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, shell, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`${command} ${args.join(" ")} failed (${code}).\n${stdout}\n${stderr}`)));
  });
}

function npmCommand() { return process.platform === "win32" ? "npm.cmd" : "npm"; }
