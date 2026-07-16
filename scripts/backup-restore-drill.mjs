import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export function validateRestoreTarget(sourceUrl, targetUrl, confirmation) {
  const source = parseDatabaseUrl(sourceUrl, "DATABASE_URL");
  const target = parseDatabaseUrl(targetUrl, "AGENTCERT_RESTORE_DATABASE_URL");
  if (sourceUrl === targetUrl || (source.host === target.host && source.port === target.port && source.database === target.database)) {
    throw new Error("Restore target must not be the source database.");
  }
  if (!/(restore|drill|sandbox)/i.test(target.database)) {
    throw new Error("Restore target database name must contain restore, drill, or sandbox.");
  }
  if (confirmation !== target.database) {
    throw new Error("AGENTCERT_RESTORE_CONFIRM must exactly match the restore target database name.");
  }
  return { source, target };
}

async function main() {
  const sourceUrl = required("DATABASE_URL");
  const targetUrl = required("AGENTCERT_RESTORE_DATABASE_URL");
  const { source, target } = validateRestoreTarget(sourceUrl, targetUrl, required("AGENTCERT_RESTORE_CONFIRM"));
  const work = await mkdtemp(join(tmpdir(), "agentcert-restore-drill-"));
  const dump = join(work, "agentcert.dump");
  try {
    await run("pg_dump", [...connectionArgs(source), "--dbname", source.database, "--format=custom", "--file", dump], source);
    await run("pg_restore", [...connectionArgs(target), "--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", target.database, dump], target);
    const sourceCounts = await tableCounts(source);
    const targetCounts = await tableCounts(target);
    const matches = JSON.stringify(sourceCounts) === JSON.stringify(targetCounts);
    const report = {
      schemaVersion: "agentcert.backup_restore_drill.v0.1", performedAt: new Date().toISOString(),
      source: safeIdentity(source), target: safeIdentity(target), sourceCounts, targetCounts, matches,
    };
    const output = resolve(process.env.AGENTCERT_RESTORE_REPORT ?? `.agentcert/drills/backup-restore-${Date.now()}.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Backup/restore drill ${matches ? "passed" : "failed"}. Report: ${output}\n`);
    if (!matches) process.exitCode = 1;
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function tableCounts(database) {
  const query = `SELECT table_name || '=' || row_count FROM (VALUES
    ('agentcert_organizations', (SELECT count(*) FROM agentcert_organizations)),
    ('agentcert_projects', (SELECT count(*) FROM agentcert_projects)),
    ('agentcert_runs', (SELECT count(*) FROM agentcert_runs)),
    ('agentcert_evidence', (SELECT count(*) FROM agentcert_evidence)),
    ('agentcert_pilot_feedback', (SELECT count(*) FROM agentcert_pilot_feedback))
  ) AS counts(table_name,row_count) ORDER BY table_name;`;
  const output = await run("psql", [...connectionArgs(database), "--dbname", database.database, "--tuples-only", "--no-align", "--command", query], database);
  return Object.fromEntries(output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, count] = line.split("="); return [name, Number(count)];
  }));
}

function parseDatabaseUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid PostgreSQL URL.`); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) throw new Error(`${name} must use postgresql://.`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error(`${name} must include a database name.`);
  return { host: parsed.hostname, port: parsed.port || "5432", database, user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), sslmode: parsed.searchParams.get("sslmode") };
}

function connectionArgs(database) {
  return ["--host", database.host, "--port", database.port, "--username", database.user];
}

function safeIdentity(database) { return { host: database.host, port: database.port, database: database.database, user: database.user }; }
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function run(command, args, database) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PGPASSWORD: database.password, ...(database.sslmode ? { PGSSLMODE: database.sslmode } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => reject(new Error(`${command} is unavailable: ${error.message}`)));
    child.once("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
