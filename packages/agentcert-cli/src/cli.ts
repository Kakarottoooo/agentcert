#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildEvidenceBundle } from "./bundle.js";
import { normalizeMcpBenchResult, normalizeOnegentAuditPacket, normalizeTripwireResult } from "./normalizers.js";
import { renderMarkdownReport } from "./report.js";
import type { AgentCertConfig, AgentCertResult } from "./types.js";

const command = process.argv[2] ?? "help";

if (command === "init") {
  const outPath = resolve(readFlag("--out") ?? "agentcert.config.json");
  const config: AgentCertConfig = {
    schemaVersion: "1",
    subject: {
      name: "my-agent",
      type: "agent",
    },
    artifacts: {
      mcpbench: ".mcpbench/latest/results.json",
      tripwire: "packages/tripwire-ci/.tripwire/latest/tripwire-result.json",
      onegent: "packages/onegent-runtime/.onegent/procurement/audit-packet.json",
    },
    outputDir: ".agentcert/latest",
  };
  await writeFile(outPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`Wrote ${outPath}\n`);
} else if (command === "report") {
  const config = await loadConfig(readFlag("--config"));
  const subject = readFlag("--subject") ?? config?.subject.name ?? "agentcert-subject";
  const subjectType = readFlag("--subject-type") ?? config?.subject.type ?? "agent";
  const outDir = resolve(readFlag("--out") ?? config?.outputDir ?? ".agentcert/latest");
  const results: AgentCertResult[] = [];

  const mcpbenchPath = readFlag("--mcpbench") ?? config?.artifacts.mcpbench;
  const tripwirePath = readFlag("--tripwire") ?? config?.artifacts.tripwire;
  const onegentPath = readFlag("--onegent") ?? config?.artifacts.onegent;

  if (mcpbenchPath) {
    results.push(normalizeMcpBenchResult(await readJson(mcpbenchPath), mcpbenchPath));
  }
  if (tripwirePath) {
    results.push(normalizeTripwireResult(await readJson(tripwirePath), tripwirePath));
  }
  if (onegentPath) {
    results.push(normalizeOnegentAuditPacket(await readJson(onegentPath), onegentPath));
  }

  if (results.length === 0) {
    throw new Error("No input artifacts were provided. Use --mcpbench, --tripwire, --onegent, or --config.");
  }

  const bundle = buildEvidenceBundle(results, subject, subjectType);
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/agentcert-evidence.json`, `${JSON.stringify(bundle, null, 2)}\n`);
  await writeFile(`${outDir}/agentcert-report.md`, renderMarkdownReport(bundle));
  process.stdout.write(`Wrote ${outDir}\\agentcert-evidence.json\n`);
  process.stdout.write(`Wrote ${outDir}\\agentcert-report.md\n`);
  process.exitCode = bundle.verdict.passed ? 0 : 1;
} else {
  process.stdout.write(`Usage:
  agentcert init --out agentcert.config.json
  agentcert report --mcpbench .mcpbench/latest/results.json --tripwire .tripwire/latest/tripwire-result.json --onegent .onegent/procurement/audit-packet.json --out .agentcert/latest --subject my-agent
`);
}

async function loadConfig(path?: string): Promise<AgentCertConfig | undefined> {
  if (!path) {
    return undefined;
  }
  return (await readJson(path)) as AgentCertConfig;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw);
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
