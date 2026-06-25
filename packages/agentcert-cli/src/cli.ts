#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAgentCertBadge } from "./badge.js";
import { buildEvidenceBundle } from "./bundle.js";
import { recordsFromAgentCertResult, renderCorpusSummary, summarizeCorpus } from "./corpus.js";
import { openCorpusStore, parseCorpusStoreKind, type CorpusStoreOptions } from "./corpus-store.js";
import {
  applyFailureReviews,
  appendFailureReview,
  createFailureReview,
  findFailurePattern,
  parseFailureReviewStatus,
  parseFailureType,
  parseReviewConfidence,
  readFailureReviews,
} from "./failure-review.js";
import { buildMonitorSnapshot, writeMonitorSnapshot } from "./monitor.js";
import { normalizeMcpBenchResult, normalizeOnegentAuditPacket, normalizeTripwireResult } from "./normalizers.js";
import { renderMarkdownReport } from "./report.js";
import { serveAgentCertMonitor } from "./local-server.js";
import { loadRunProfile, profileFromArtifactFlags, renderRunSummary, runAgentCertProfile, type RunProfileOverrides } from "./runner.js";
import { buildRobustnessLabSnapshot, readRobustnessLabConfig, renderRobustnessLabSummary, writeRobustnessLabSnapshot } from "./lab.js";
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
  await writeFile(`${outDir}/badge.svg`, renderAgentCertBadge(bundle));
  process.stdout.write(`Wrote ${outDir}\\agentcert-evidence.json\n`);
  process.stdout.write(`Wrote ${outDir}\\agentcert-report.md\n`);
  process.stdout.write(`Wrote ${outDir}\\badge.svg\n`);
  process.exitCode = bundle.verdict.passed ? 0 : 1;
} else if (command === "corpus") {
  const action = process.argv[3] ?? "help";
  if (action === "ingest") {
    const config = await loadConfig(readFlag("--config"));
    const subject = readFlag("--subject") ?? config?.subject.name ?? "agentcert-subject";
    const storeOptions = readCorpusStoreOptions(".agentcert/corpus/corpus.jsonl", readFlag("--out"));
    const replace = readBoolFlag("--replace");
    const loaded = await loadArtifactResults(config);

    if (loaded.length === 0) {
      throw new Error("No input artifacts were provided. Use --mcpbench, --tripwire, --onegent, or --config.");
    }

    const reviews = await readFailureReviews(readReviewsPath());
    const records = applyFailureReviews(
      loaded.flatMap(({ result, path, raw }) => recordsFromAgentCertResult(result, path, subject, raw)),
      reviews,
    );
    const store = await openCorpusStore(storeOptions);
    try {
      await store.append(records, { replace });
      process.stdout.write(`Wrote ${records.length} corpus records to ${store.description}\n`);
    } finally {
      await store.close();
    }
    const summary = summarizeCorpus(records);
    process.stdout.write(renderCorpusSummary(summary));
  } else if (action === "summary") {
    const store = await openCorpusStore(readCorpusStoreOptions(".agentcert/corpus/corpus.jsonl"));
    try {
      const records = applyFailureReviews(await store.readAll(), await readFailureReviews(readReviewsPath()));
      process.stdout.write(renderCorpusSummary(summarizeCorpus(records)));
    } finally {
      await store.close();
    }
  } else if (action === "review") {
    const storeOptions = readCorpusStoreOptions(".agentcert/corpus/corpus.jsonl");
    const reviewPath = readReviewsPath() ?? ".agentcert/corpus/failure-reviews.jsonl";
    const store = await openCorpusStore(storeOptions);
    try {
      const records = await store.readAll();
      const target = {
        patternKey: requiredFlag("--pattern-key"),
        recordId: readFlag("--record-id"),
        runId: readFlag("--run-id"),
        product: readFlag("--product"),
        scenarioName: readFlag("--scenario"),
        faultName: readFlag("--fault"),
      };
      const matched = findFailurePattern(records, target);
      const type = parseFailureType(readFlag("--type"));
      const suggestedType = matched?.pattern.suggestedType ?? matched?.pattern.type;
      const status = parseFailureReviewStatus(readFlag("--status"), type, suggestedType);
      const review = createFailureReview({
        target,
        type,
        status,
        suggestedType,
        reviewer: readFlag("--reviewer"),
        note: readFlag("--note"),
        confidence: parseReviewConfidence(readFlag("--confidence")),
        evidenceContext: readReviewEvidenceContextFromFlags(),
        taxonomyRationale: readReviewTaxonomyRationaleFromFlags(),
      });
      await appendFailureReview(reviewPath, review);
      const updated = applyFailureReviews(records, await readFailureReviews(reviewPath));
      await store.append(updated, { replace: true });
      process.stdout.write(`Wrote failure review ${review.id} to ${resolve(reviewPath)}\n`);
      process.stdout.write(`Updated ${updated.length} corpus records in ${store.description}\n`);
    } finally {
      await store.close();
    }
  } else {
    process.stdout.write(`Usage:
  agentcert corpus ingest --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/corpus/corpus.jsonl --subject my-agent
  agentcert corpus ingest --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --tripwire .tripwire/latest/tripwire-result.json --subject my-agent
  agentcert corpus review --corpus .agentcert/corpus/corpus.jsonl --reviews .agentcert/corpus/failure-reviews.jsonl --pattern-key tripwire:ui_drift:modal-overlay:url_contains --type ui_drift --status confirmed --reviewer you@example.com --confidence 0.8 --why "Visible evidence supports the ui_drift label."
  agentcert corpus summary --corpus .agentcert/corpus/corpus.jsonl
  agentcert corpus summary --store postgres --database-url "$DATABASE_URL"
`);
  }
} else if (command === "monitor") {
  const action = process.argv[3] ?? "help";
  if (action === "build") {
    const outPath = readFlag("--out") ?? ".agentcert/monitor/monitor.json";
    const subject = readFlag("--subject") ?? "agentcert-subject";
    const detailUrl = readFlag("--detail-url");
    const store = await openCorpusStore(readCorpusStoreOptions(".agentcert/corpus/corpus.jsonl"));
    try {
      const records = applyFailureReviews(await store.readAll(), await readFailureReviews(readReviewsPath()));
      const snapshot = buildMonitorSnapshot(records, { subject, detailUrl });
      await writeMonitorSnapshot(outPath, snapshot);
      process.stdout.write(`Wrote ${resolve(outPath)}\n`);
      process.stdout.write(
        `Monitor snapshot: ${snapshot.summary.totalRecords} records, ${(snapshot.summary.passRate * 100).toFixed(1)}% pass rate\n`,
      );
    } finally {
      await store.close();
    }
  } else {
    process.stdout.write(`Usage:
  agentcert monitor build --corpus .agentcert/corpus/corpus.jsonl --out packages/agentcert-dashboard/public/data/monitor.json --subject my-agent
  agentcert monitor build --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --out packages/agentcert-dashboard/public/data/monitor.json --subject my-agent
`);
  }
} else if (command === "run") {
  const overrides = readRunOverrides();
  const profileName = readFlag("--profile");
  const configPath = readFlag("--config");
  const hasArtifactFlags = Boolean(overrides.mcpbench || overrides.tripwire || overrides.onegent);
  const profile =
    hasArtifactFlags && !profileName && !configPath
      ? profileFromArtifactFlags(overrides)
      : await loadRunProfile(profileName, configPath);
  const outcome = await runAgentCertProfile(profile, {
    runCommands: !readBoolFlag("--skip-commands"),
    overrides,
  });
  process.stdout.write(renderRunSummary(outcome));
  process.exitCode = outcome.exitCode;
} else if (command === "lab") {
  const action = process.argv[3] ?? "help";
  if (action === "build") {
    const configPath = readFlag("--config") ?? "examples/real-agents/robustness-lab/lab.config.json";
    const outPath = readFlag("--out") ?? "public-demo/real-agent-robustness/evidence/lab-snapshot.json";
    const config = await readRobustnessLabConfig(configPath);
    const snapshot = await buildRobustnessLabSnapshot(config);
    await writeRobustnessLabSnapshot(outPath, snapshot);
    process.stdout.write(`Wrote ${resolve(outPath)}\n`);
    process.stdout.write(renderRobustnessLabSummary(snapshot));
  } else {
    process.stdout.write(`Usage:
  agentcert lab build --config examples/real-agents/robustness-lab/lab.config.json --out public-demo/real-agent-robustness/evidence/lab-snapshot.json
`);
  }
} else if (command === "serve") {
  await serveAgentCertMonitor({
    host: readFlag("--host") ?? "127.0.0.1",
    port: Number(readFlag("--port") ?? process.env.PORT ?? 8765),
    subject: readFlag("--subject") ?? "agentcert-local",
    detailUrl: readFlag("--detail-url") ?? "../browser-agent-robustness/",
    staticDir: readFlag("--static") ?? "public-demo/agentcert-monitor",
    artifactRoot: readFlag("--artifact-root") ?? "public-demo/browser-agent-robustness/evidence/tripwire-public-demo",
    store: readCorpusStoreOptions("public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl"),
    reviewsPath: readReviewsPath() ?? "public-demo/browser-agent-robustness/evidence/failure-reviews.jsonl",
  });
} else {
  process.stdout.write(`Usage:
  agentcert init --out agentcert.config.json
  agentcert report --mcpbench .mcpbench/latest/results.json --tripwire .tripwire/latest/tripwire-result.json --onegent .onegent/procurement/audit-packet.json --out .agentcert/latest --subject my-agent
  agentcert corpus ingest --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/corpus/corpus.jsonl --subject my-agent
  agentcert corpus review --corpus .agentcert/corpus/corpus.jsonl --reviews .agentcert/corpus/failure-reviews.jsonl --pattern-key <failure-key> --type wrong_click --status corrected
  agentcert corpus summary --corpus .agentcert/corpus/corpus.jsonl
  agentcert monitor build --corpus .agentcert/corpus/corpus.jsonl --out .agentcert/monitor/monitor.json --subject my-agent
  agentcert monitor build --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --out .agentcert/monitor/monitor.json --subject my-agent
  agentcert run --profile public-demo
  agentcert run --mcpbench .mcpbench/latest/results.json --tripwire .tripwire/latest/tripwire-result.json --onegent .onegent/procurement/audit-packet.json --out .agentcert/latest --corpus .agentcert/corpus/corpus.jsonl --monitor-out .agentcert/monitor/monitor.json
  agentcert lab build --config examples/real-agents/robustness-lab/lab.config.json --out public-demo/real-agent-robustness/evidence/lab-snapshot.json
  agentcert serve --corpus .agentcert/corpus/corpus.jsonl --static public-demo/agentcert-monitor --artifact-root public-demo/browser-agent-robustness/evidence/tripwire-public-demo
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

function readRepeatedFlag(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function readReviewEvidenceContextFromFlags() {
  const firstDivergenceSnippet = readFlag("--first-divergence") ?? readFlag("--first-divergence-snippet");
  const screenshotPath = readFlag("--screenshot") ?? readFlag("--screenshot-path");
  const screenshotUrl = readFlag("--screenshot-url");
  const tracePath = readFlag("--trace") ?? readFlag("--trace-path");
  const stepIndex = parseOptionalNonNegativeInteger(readFlag("--step-index"), "--step-index");
  if (!firstDivergenceSnippet && !screenshotPath && !screenshotUrl && !tracePath && stepIndex === undefined) {
    return undefined;
  }
  return {
    firstDivergenceSnippet,
    screenshotPath,
    screenshotUrl,
    tracePath,
    stepIndex,
  };
}

function readReviewTaxonomyRationaleFromFlags() {
  const primaryReason = readFlag("--why") ?? readFlag("--taxonomy-reason");
  const supportingSignals = readRepeatedFlag("--signal");
  const contradictingSignals = readRepeatedFlag("--contradiction");
  const classifierLimitation = readFlag("--classifier-limitation");
  if (!primaryReason) {
    return undefined;
  }
  return {
    primaryReason,
    supportingSignals: supportingSignals.length > 0 ? supportingSignals : undefined,
    contradictingSignals: contradictingSignals.length > 0 ? contradictingSignals : undefined,
    classifierLimitation,
  };
}

function readRunOverrides(): RunProfileOverrides {
  return {
    subject: readFlag("--subject"),
    mcpbench: readFlag("--mcpbench"),
    tripwire: readFlag("--tripwire"),
    onegent: readFlag("--onegent"),
    outDir: readFlag("--out"),
    corpusPath: readFlag("--corpus"),
    monitorOut: readFlag("--monitor-out"),
    reviewsPath: readReviewsPath(),
    replaceCorpus: readBoolFlag("--replace") ? true : undefined,
    failOnVerdict: readBoolFlag("--fail-on-verdict") ? true : undefined,
  };
}

function requiredFlag(name: string): string {
  const value = readFlag(name);
  if (!value) {
    throw new Error(`Missing required flag ${name}.`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(input: string | undefined, flagName: string): number | undefined {
  if (input === undefined) return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return value;
}

function readReviewsPath(): string | undefined {
  return readFlag("--reviews") ?? process.env.AGENTCERT_FAILURE_REVIEWS;
}

function readCorpusStoreOptions(defaultJsonlPath: string, outPath?: string): CorpusStoreOptions {
  return {
    kind: parseCorpusStoreKind(readFlag("--store") ?? process.env.AGENTCERT_CORPUS_STORE),
    jsonlPath: readFlag("--corpus") ?? outPath ?? defaultJsonlPath,
    sqlitePath: readFlag("--sqlite") ?? process.env.AGENTCERT_SQLITE_PATH ?? ".agentcert/corpus/agentcert.sqlite",
    databaseUrl: readFlag("--database-url") ?? process.env.AGENTCERT_DATABASE_URL ?? process.env.DATABASE_URL,
    tableName: readFlag("--table") ?? process.env.AGENTCERT_CORPUS_TABLE,
  };
}
