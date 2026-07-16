import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const templates = ["browser", "coding", "mcp", "workflow", "data"];
const versions = (process.env.AGENTCERT_COMPAT_VERSIONS ?? "0.5.1,latest").split(",").map((item) => item.trim()).filter(Boolean);
const output = resolve(process.env.AGENTCERT_COMPAT_OUTPUT ?? ".agentcert/compatibility/adapter-matrix.json");
const root = await mkdtemp(join(tmpdir(), "agentcert-compat-"));
const results = [];

try {
  for (const version of versions) {
    for (const template of templates) {
      const cwd = join(root, `${version.replaceAll(/[^a-z0-9.-]/gi, "-")}-${template}`);
      await mkdir(cwd, { recursive: true });
      const started = Date.now();
      try {
        await runNpx(version, ["init", "--template", template, "--subject", `compat-${template}`], cwd);
        const validation = await validateTemplate(cwd, template, version);
        results.push({ version, template, status: validation.supported ? "passed" : "unsupported", durationMs: Date.now() - started, ...(validation.reason ? { reason: validation.reason } : {}) });
      } catch (error) {
        results.push({ version, template, status: "failed", durationMs: Date.now() - started, error: bounded(error) });
      }
    }
  }

  for (const template of templates) {
    const cwd = join(root, `upgrade-${template}`);
    await mkdir(cwd, { recursive: true });
    const started = Date.now();
    try {
      await runNpx(versions[0], ["init", "--template", template, "--subject", `upgrade-${template}`], cwd);
      await runNpx("latest", ["init", "--template", template, "--subject", `upgrade-${template}`, "--force"], cwd);
      await validateTemplate(cwd, template, "latest");
      results.push({ version: `${versions[0]}->latest`, template, status: "passed", durationMs: Date.now() - started, mode: "upgrade" });
    } catch (error) {
      results.push({ version: `${versions[0]}->latest`, template, status: "failed", durationMs: Date.now() - started, mode: "upgrade", error: bounded(error) });
    }
  }

  const report = {
    schemaVersion: "agentcert.adapter_compatibility.v0.1",
    generatedAt: new Date().toISOString(),
    registry: "https://registry.npmjs.org/",
    versions,
    templates,
    passed: results.filter((item) => item.status === "passed").length,
    unsupported: results.filter((item) => item.status === "unsupported").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function validateTemplate(cwd, template, version) {
  const profile = JSON.parse(await readFile(join(cwd, "agentcert.config.json"), "utf8"));
  if (profile.schemaVersion !== "1" || profile.subject.name !== `compat-${template}` && profile.subject.name !== `upgrade-${template}`) {
    throw new Error("Generated profile contract is invalid.");
  }
  if (["coding", "workflow", "data"].includes(template)) {
    try { await readFile(join(cwd, "agentcert.adapter.mjs")); }
    catch (error) {
      if (version !== "latest") return { supported: false, reason: `${version} predates generated universal envelope adapters.` };
      throw error;
    }
    await run(process.execPath, ["--check", "agentcert.adapter.mjs"], cwd);
  }
  if (template === "browser") await readFile(join(cwd, "tripwire.yml"));
  return { supported: true };
}

function runNpx(version, args, cwd) {
  return run(npxCommand(), ["--yes", `agentcert@${version}`, ...args], cwd, { npm_config_registry: "https://registry.npmjs.org/" });
}

function run(command, args, cwd, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${command} failed (${code}): ${output}`)));
  });
}

function npxCommand() { return process.platform === "win32" ? "npx.cmd" : "npx"; }
function bounded(error) { return (error instanceof Error ? error.message : String(error)).replaceAll(/(?:sk|rk|npm|ac)_[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 2000); }
