#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildEvidenceBundle } from "./bundle.js";
import { appendCorpusRecords, readCorpus, recordsFromAgentCertResult, renderCorpusSummary, summarizeCorpus } from "./corpus.js";
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
  const loaded = await loadArtifactResults(config);
  const results = loaded.map((artifact) => artifact.result);

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
} else if (command === "corpus") {
  const action = process.argv[3] ?? "help";
  if (action === "ingest") {
    const config = await loadConfig(readFlag("--config"));
    const subject = readFlag("--subject") ?? config?.subject.name ?? "agentcert-subject";
    const outPath = readFlag("--out") ?? ".agentcert/corpus/corpus.jsonl";
    const replace = readBoolFlag("--replace");
    const loaded = await loadArtifactResults(config);

    if (loaded.length === 0) {
      throw new Error("No input artifacts were provided. Use --mcpbench, --tripwire, --onegent, or --config.");
    }

    const records = loaded.flatMap(({ result, path, raw }) => recordsFromAgentCertResult(result, path, subject, raw));
    await appendCorpusRecords(outPath, records, replace);
    const summary = summarizeCorpus(records);
    process.stdout.write(`Wrote ${records.length} corpus records to ${resolve(outPath)}\n`);
    process.stdout.write(renderCorpusSummary(summary));
  } else if (action === "summary") {
    const corpusPath = readFlag("--corpus") ?? ".agentcert/corpus/corpus.jsonl";
    const records = await readCorpus(corpusPath);
    process.stdout.write(renderCorpusSummary(summarizeCorpus(records)));
  } else {
    process.stdout.write(`Usage:
  agentcert corpus ingest --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/corpus/corpus.jsonl --subject my-agent
  agentcert corpus summary --corpus .agentcert/corpus/corpus.jsonl
`);
  }
} else {
  process.stdout.write(`Usage:
  agentcert init --out agentcert.config.json
  agentcert report --mcpbench .mcpbench/latest/results.json --tripwire .tripwire/latest/tripwire-result.json --onegent .onegent/procurement/audit-packet.json --out .agentcert/latest --subject my-agent
  agentcert corpus ingest --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/corpus/corpus.jsonl --subject my-agent
  agentcert corpus summary --corpus .agentcert/corpus/corpus.jsonl
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

async function loadArtifactResults(
  config?: AgentCertConfig,
): Promise<Array<{ result: AgentCertResult; path: string; raw: unknown }>> {
  const loaded: Array<{ result: AgentCertResult; path: string; raw: unknown }> = [];
  const mcpbenchPath = readFlag("--mcpbench") ?? config?.artifacts.mcpbench;
  const tripwirePath = readFlag("--tripwire") ?? config?.artifacts.tripwire;
  const onegentPath = readFlag("--onegent") ?? config?.artifacts.onegent;

  if (mcpbenchPath) {
    const raw = await readJson(mcpbenchPath);
    loaded.push({ result: normalizeMcpBenchResult(raw, mcpbenchPath), path: mcpbenchPath, raw });
  }
  if (tripwirePath) {
    const raw = await readJson(tripwirePath);
    loaded.push({ result: normalizeTripwireResult(raw, tripwirePath), path: tripwirePath, raw });
  }
  if (onegentPath) {
    const raw = await readJson(onegentPath);
    loaded.push({ result: normalizeOnegentAuditPacket(raw, onegentPath), path: onegentPath, raw });
  }

  return loaded;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readBoolFlag(name: string): boolean {
  return process.argv.includes(name);
}
