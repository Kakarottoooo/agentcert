import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildEvidenceBundle } from "./bundle.js";
import { recordsFromAgentCertResult, renderCorpusSummary, summarizeCorpus, type AgentCertCorpusRecord } from "./corpus.js";
import { openCorpusStore, parseCorpusStoreKind, type CorpusStoreOptions } from "./corpus-store.js";
import { buildMonitorSnapshot, writeMonitorSnapshot } from "./monitor.js";
import { normalizeMcpBenchResult, normalizeOnegentAuditPacket, normalizeTripwireResult } from "./normalizers.js";
import { renderMarkdownReport } from "./report.js";
import type { AgentCertBundle, AgentCertConfig, AgentCertResult } from "./types.js";

export type RunJobKey = "mcpbench" | "tripwire" | "onegent";

export interface AgentCertRunJob {
  artifact?: string;
  command?: string;
  allowCommandFailure?: boolean;
  required?: boolean;
}

export interface AgentCertRunProfile extends AgentCertConfig {
  run?: {
    jobs?: Partial<Record<RunJobKey, AgentCertRunJob>>;
    report?: {
      enabled?: boolean;
      outDir?: string;
    };
    corpus?: {
      store?: "jsonl" | "sqlite" | "postgres";
      path?: string;
      sqlitePath?: string;
      databaseUrl?: string;
      tableName?: string;
      replace?: boolean;
    };
    monitor?: {
      out?: string;
      outputs?: string[];
      detailUrl?: string;
      subject?: string;
    };
    gate?: {
      failOnVerdict?: boolean;
    };
    manifest?: {
      out?: string;
    };
  };
}

export interface RunProfileOverrides {
  subject?: string;
  mcpbench?: string;
  tripwire?: string;
  onegent?: string;
  outDir?: string;
  corpusPath?: string;
  monitorOut?: string;
  replaceCorpus?: boolean;
  failOnVerdict?: boolean;
}

export interface AgentCertRunOptions {
  cwd?: string;
  runCommands?: boolean;
  commandStdio?: "inherit" | "pipe";
  overrides?: RunProfileOverrides;
}

export interface AgentCertRunManifest {
  schemaVersion: "1";
  kind: "agentcert.run_manifest";
  runId: string;
  generatedAt: string;
  subject: AgentCertRunProfile["subject"];
  steps: AgentCertRunStep[];
  outputs: {
    reportDir?: string;
    evidenceBundle?: string;
    markdownReport?: string;
    corpus?: string;
    monitor: string[];
    manifest?: string;
  };
  verdict: AgentCertBundle["verdict"];
  summary: AgentCertBundle["summary"];
}

export interface AgentCertRunStep {
  id: RunJobKey | "corpus" | "report" | "monitor";
  status: "passed" | "failed" | "skipped";
  artifactPath?: string;
  command?: string;
  durationMs?: number;
  exitCode?: number;
  message?: string;
}

export interface AgentCertRunOutcome {
  exitCode: number;
  bundle: AgentCertBundle;
  records: AgentCertCorpusRecord[];
  manifest: AgentCertRunManifest;
}

interface LoadedArtifact {
  key: RunJobKey;
  path: string;
  raw: unknown;
  result: AgentCertResult;
}

const JOB_KEYS: RunJobKey[] = ["mcpbench", "tripwire", "onegent"];

export function publicDemoRunProfile(): AgentCertRunProfile {
  return {
    schemaVersion: "1",
    subject: {
      name: "agentcert-public-demo",
      type: "agent",
    },
    artifacts: {
      mcpbench: "public-demo/lifecycle-evidence/mcpbench-passing/results.json",
      tripwire: "public-demo/browser-agent-robustness/evidence/tripwire-public-demo/tripwire-result.json",
      onegent: "public-demo/lifecycle-evidence/onegent-procurement/audit-packet.json",
    },
    outputDir: "public-demo/browser-agent-robustness/evidence/agentcert-public-demo",
    run: {
      corpus: {
        path: "public-demo/browser-agent-robustness/evidence/agentcert-corpus.jsonl",
        replace: true,
      },
      monitor: {
        outputs: [
          "packages/agentcert-dashboard/public/data/monitor.json",
          "public-demo/agentcert-monitor/data/monitor.json",
        ],
        detailUrl: "../browser-agent-robustness/",
      },
      gate: {
        failOnVerdict: false,
      },
    },
  };
}

export async function loadRunProfile(profileName: string | undefined, configPath: string | undefined): Promise<AgentCertRunProfile> {
  if (profileName === "public-demo") {
    return publicDemoRunProfile();
  }
  if (profileName && profileName !== "public-demo") {
    throw new Error(`Unknown AgentCert run profile "${profileName}". Available profiles: public-demo.`);
  }
  if (configPath) {
    return (await readJson(configPath)) as AgentCertRunProfile;
  }
  const defaultConfigPath = "agentcert.config.json";
  try {
    await access(resolve(defaultConfigPath));
    return (await readJson(defaultConfigPath)) as AgentCertRunProfile;
  } catch {
    throw new Error("agentcert run requires --profile public-demo, --config <path>, explicit artifact flags, or agentcert.config.json in the current directory.");
  }
}

export function profileFromArtifactFlags(overrides: RunProfileOverrides): AgentCertRunProfile {
  return {
    schemaVersion: "1",
    subject: {
      name: overrides.subject ?? "agentcert-subject",
      type: "agent",
    },
    artifacts: {
      mcpbench: overrides.mcpbench,
      tripwire: overrides.tripwire,
      onegent: overrides.onegent,
    },
    outputDir: overrides.outDir ?? ".agentcert/latest",
    run: {
      corpus: {
        path: overrides.corpusPath ?? ".agentcert/corpus/corpus.jsonl",
        replace: overrides.replaceCorpus ?? false,
      },
      monitor: overrides.monitorOut ? { outputs: [overrides.monitorOut] } : undefined,
      gate: {
        failOnVerdict: overrides.failOnVerdict ?? false,
      },
    },
  };
}

export function applyRunOverrides(profile: AgentCertRunProfile, overrides: RunProfileOverrides = {}): AgentCertRunProfile {
  const next: AgentCertRunProfile = {
    ...profile,
    subject: {
      ...profile.subject,
      name: overrides.subject ?? profile.subject.name,
    },
    artifacts: {
      ...profile.artifacts,
      ...(overrides.mcpbench ? { mcpbench: overrides.mcpbench } : {}),
      ...(overrides.tripwire ? { tripwire: overrides.tripwire } : {}),
      ...(overrides.onegent ? { onegent: overrides.onegent } : {}),
    },
    outputDir: overrides.outDir ?? profile.outputDir,
    run: {
      ...profile.run,
      corpus: {
        ...profile.run?.corpus,
        ...(overrides.corpusPath ? { path: overrides.corpusPath } : {}),
        ...(overrides.replaceCorpus === undefined ? {} : { replace: overrides.replaceCorpus }),
      },
      monitor: {
        ...profile.run?.monitor,
        ...(overrides.monitorOut ? { outputs: [overrides.monitorOut] } : {}),
      },
      gate: {
        ...profile.run?.gate,
        ...(overrides.failOnVerdict === undefined ? {} : { failOnVerdict: overrides.failOnVerdict }),
      },
    },
  };

  return next;
}

export async function runAgentCertProfile(profileInput: AgentCertRunProfile, options: AgentCertRunOptions = {}): Promise<AgentCertRunOutcome> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const profile = applyRunOverrides(profileInput, options.overrides);
  const steps: AgentCertRunStep[] = [];
  const loaded: LoadedArtifact[] = [];

  for (const key of JOB_KEYS) {
    const job = jobFor(profile, key);
    if (!job.artifact && !job.command) {
      steps.push({ id: key, status: "skipped", message: "No command or artifact configured." });
      continue;
    }

    if (job.command && options.runCommands !== false) {
      const step = await runJobCommand(key, job.command, cwd, options.commandStdio ?? "inherit");
      steps.push(step);
      if (step.status === "failed" && !job.allowCommandFailure) {
        throw new Error(`${key} command failed with exit code ${step.exitCode ?? "unknown"}.`);
      }
    }

    if (!job.artifact) {
      if (job.required !== false) {
        throw new Error(`${key} did not define an artifact path.`);
      }
      steps.push({ id: key, status: "skipped", message: "No artifact configured." });
      continue;
    }

    const raw = await readJson(job.artifact, cwd);
    loaded.push({ key, path: job.artifact, raw, result: normalizeArtifact(key, raw, job.artifact) });
    steps.push({ id: key, status: "passed", artifactPath: job.artifact });
  }

  if (loaded.length === 0) {
    throw new Error("No AgentCert artifacts were loaded. Configure at least one MCPBench, Tripwire, or Onegent artifact.");
  }

  const bundle = buildEvidenceBundle(
    loaded.map((artifact) => artifact.result),
    profile.subject.name,
    profile.subject.type,
  );
  const records = loaded.flatMap(({ result, path, raw }) => recordsFromAgentCertResult(result, path, profile.subject.name, raw));
  const outputs: AgentCertRunManifest["outputs"] = { monitor: [] };

  const reportEnabled = profile.run?.report?.enabled ?? true;
  const reportDir = profile.run?.report?.outDir ?? profile.outputDir;
  if (reportEnabled && reportDir) {
    const resolvedReportDir = resolve(cwd, reportDir);
    await mkdir(resolvedReportDir, { recursive: true });
    await writeFile(`${resolvedReportDir}/agentcert-evidence.json`, `${JSON.stringify(bundle, null, 2)}\n`);
    await writeFile(`${resolvedReportDir}/agentcert-report.md`, renderMarkdownReport(bundle));
    steps.push({ id: "report", status: "passed", artifactPath: reportDir });
    outputs.reportDir = reportDir;
    outputs.evidenceBundle = artifactPath(reportDir, "agentcert-evidence.json");
    outputs.markdownReport = artifactPath(reportDir, "agentcert-report.md");
  } else {
    steps.push({ id: "report", status: "skipped", message: "Report output disabled." });
  }

  const corpusOptions = corpusStoreOptions(profile, cwd);
  const store = await openCorpusStore(corpusOptions);
  try {
    await store.append(records, { replace: profile.run?.corpus?.replace ?? false });
    const allRecords = await store.readAll();
    steps.push({ id: "corpus", status: "passed", artifactPath: profile.run?.corpus?.path ?? corpusOptions.jsonlPath });
    outputs.corpus = profile.run?.corpus?.path ?? corpusOptions.jsonlPath ?? store.description;

    const monitorOutputs = monitorOutputsFor(profile);
    for (const outPath of monitorOutputs) {
      const snapshot = buildMonitorSnapshot(allRecords, {
        subject: profile.run?.monitor?.subject ?? profile.subject.name,
        detailUrl: profile.run?.monitor?.detailUrl,
      });
      await writeMonitorSnapshot(resolve(cwd, outPath), snapshot);
      outputs.monitor.push(outPath);
    }
    steps.push({
      id: "monitor",
      status: monitorOutputs.length > 0 ? "passed" : "skipped",
      artifactPath: monitorOutputs.join(", "),
      message: monitorOutputs.length > 0 ? undefined : "No monitor output configured.",
    });
  } finally {
    await store.close();
  }

  const manifestPath = profile.run?.manifest?.out ?? (profile.outputDir ? join(profile.outputDir, "agentcert-run-manifest.json") : undefined);
  const manifest: AgentCertRunManifest = {
    schemaVersion: "1",
    kind: "agentcert.run_manifest",
    runId: stableRunId(profile, bundle),
    generatedAt: new Date().toISOString(),
    subject: profile.subject,
    steps,
    outputs,
    verdict: bundle.verdict,
    summary: bundle.summary,
  };

  if (manifestPath) {
    const resolvedManifestPath = resolve(cwd, manifestPath);
    await mkdir(dirname(resolvedManifestPath), { recursive: true });
    manifest.outputs.manifest = normalizeArtifactPath(manifestPath);
    await writeFile(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const failOnVerdict = profile.run?.gate?.failOnVerdict ?? false;
  return {
    exitCode: failOnVerdict && !bundle.verdict.passed ? 1 : 0,
    bundle,
    records,
    manifest,
  };
}

export function renderRunSummary(outcome: AgentCertRunOutcome): string {
  const lines = [
    "# AgentCert Run",
    "",
    `Subject: ${outcome.manifest.subject.name}`,
    `Verdict: ${outcome.bundle.verdict.passed ? "PASS" : "FAIL"} (${outcome.bundle.verdict.score}/100)`,
    `Products: ${outcome.bundle.summary.products.join(", ")}`,
    `Records: ${outcome.records.length}`,
    "",
    "## Outputs",
    ...Object.entries(outcome.manifest.outputs)
      .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
      .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value}`),
    "",
    "## Corpus Summary",
    renderCorpusSummary(summarizeCorpus(outcome.records)).trim(),
  ];
  return `${lines.join("\n")}\n`;
}

async function runJobCommand(
  id: RunJobKey,
  command: string,
  cwd: string,
  stdio: "inherit" | "pipe",
): Promise<AgentCertRunStep> {
  const startedAt = Date.now();
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio });
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  const durationMs = Date.now() - startedAt;
  return {
    id,
    command,
    durationMs,
    exitCode: exitCode ?? undefined,
    status: exitCode === 0 ? "passed" : "failed",
  };
}

function jobFor(profile: AgentCertRunProfile, key: RunJobKey): AgentCertRunJob {
  const explicit = profile.run?.jobs?.[key] ?? {};
  return {
    required: true,
    ...explicit,
    artifact: explicit.artifact ?? profile.artifacts[key],
  };
}

function normalizeArtifact(key: RunJobKey, raw: unknown, artifactPath: string): AgentCertResult {
  if (key === "mcpbench") return normalizeMcpBenchResult(raw, artifactPath);
  if (key === "tripwire") return normalizeTripwireResult(raw, artifactPath);
  return normalizeOnegentAuditPacket(raw, artifactPath);
}

function corpusStoreOptions(profile: AgentCertRunProfile, cwd: string): CorpusStoreOptions {
  const corpus = profile.run?.corpus ?? {};
  return {
    kind: parseCorpusStoreKind(corpus.store),
    jsonlPath: corpus.path ? resolve(cwd, corpus.path) : resolve(cwd, ".agentcert/corpus/corpus.jsonl"),
    sqlitePath: corpus.sqlitePath ? resolve(cwd, corpus.sqlitePath) : resolve(cwd, ".agentcert/corpus/agentcert.sqlite"),
    databaseUrl: corpus.databaseUrl ?? process.env.AGENTCERT_DATABASE_URL ?? process.env.DATABASE_URL,
    tableName: corpus.tableName,
  };
}

function monitorOutputsFor(profile: AgentCertRunProfile): string[] {
  const monitor = profile.run?.monitor;
  return [...(monitor?.outputs ?? []), ...(monitor?.out ? [monitor.out] : [])];
}

function artifactPath(base: string, file: string): string {
  return normalizeArtifactPath(`${base.replace(/[\\/]+$/, "")}/${file}`);
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function readJson(path: string, cwd = process.cwd()): Promise<unknown> {
  const fullPath = resolve(cwd, path);
  await access(fullPath);
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw);
}

function stableRunId(profile: AgentCertRunProfile, bundle: AgentCertBundle): string {
  const hash = createHash("sha256")
    .update(`${profile.subject.name}:${bundle.runId}:${JSON.stringify(bundle.summary)}`)
    .digest("hex")
    .slice(0, 12);
  return `agentcert_run_${hash}`;
}
