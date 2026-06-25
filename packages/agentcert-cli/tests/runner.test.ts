import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileFromArtifactFlags, publicDemoRunProfile, runAgentCertProfile, type AgentCertRunProfile } from "../src/runner.js";
import type { MonitorSnapshot } from "../src/monitor.js";

describe("AgentCert unified runner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentcert-runner-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds report, corpus, monitor, and manifest from lifecycle artifacts", async () => {
    const profile = await createRunProfile(dir, false);

    const outcome = await runAgentCertProfile(profile, { commandStdio: "pipe" });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.bundle.summary.products).toEqual(["mcpbench", "tripwire-ci", "onegent-runtime"]);
    expect(outcome.records).toHaveLength(3);
    expect(outcome.manifest.outputs.evidenceBundle).toBe(slashPath(join(dir, "report", "agentcert-evidence.json")));
    expect(outcome.manifest.outputs.badge).toBe(slashPath(join(dir, "report", "badge.svg")));
    expect(outcome.manifest.outputs.monitor).toEqual([join(dir, "monitor.json")]);
    expect(outcome.manifest.outputs.reviewedDataset).toEqual([join(dir, "reviewed-dataset.jsonl")]);

    const report = await readFile(join(dir, "report", "agentcert-report.md"), "utf8");
    expect(report).toContain("- mcpbench: PASS");
    expect(report).toContain("- tripwire-ci: FAIL");
    expect(report).toContain("- onegent-runtime: PASS");
    const badge = await readFile(join(dir, "report", "badge.svg"), "utf8");
    expect(badge).toContain("agentcert: fail");

    const monitor = JSON.parse(await readFile(join(dir, "monitor.json"), "utf8")) as MonitorSnapshot;
    expect(monitor.summary.totalRecords).toBe(3);
    expect(monitor.lifecycle.find((gate) => gate.id === "mcpbench")).toMatchObject({ status: "passing", recordCount: 1 });
    expect(monitor.lifecycle.find((gate) => gate.id === "tripwire-ci")).toMatchObject({ status: "failing", recordCount: 1 });
    expect(monitor.lifecycle.find((gate) => gate.id === "onegent-runtime")).toMatchObject({ status: "passing", recordCount: 1 });

    const manifest = JSON.parse(await readFile(join(dir, "report", "agentcert-run-manifest.json"), "utf8"));
    expect(manifest.kind).toBe("agentcert.run_manifest");
    expect(manifest.steps.map((step: { id: string }) => step.id)).toContain("corpus");
    expect(manifest.steps.map((step: { id: string }) => step.id)).toContain("dataset");
  });

  it("returns a CI failure code when failOnVerdict is enabled", async () => {
    const profile = await createRunProfile(dir, true);

    const outcome = await runAgentCertProfile(profile, { commandStdio: "pipe" });

    expect(outcome.bundle.verdict.passed).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it("can continue after a non-zero engine command when evidence was written", async () => {
    const profile = await createRunProfile(dir, false);
    profile.run = {
      ...profile.run,
      jobs: {
        tripwire: {
          artifact: profile.artifacts.tripwire,
          command: "node -e \"process.exit(7)\"",
          allowCommandFailure: true,
        },
      },
    };

    const outcome = await runAgentCertProfile(profile, { commandStdio: "pipe" });

    expect(outcome.records.some((record) => record.product === "tripwire-ci")).toBe(true);
    expect(outcome.manifest.steps.find((step) => step.command)?.exitCode).toBe(7);
    expect(outcome.exitCode).toBe(0);
  });

  it("exposes a built-in public demo profile", () => {
    const profile = publicDemoRunProfile();

    expect(profile.subject.name).toBe("agentcert-public-demo");
    expect(profile.artifacts.mcpbench).toContain("public-demo/lifecycle-evidence/mcpbench-passing/results.json");
    expect(profile.run?.monitor?.outputs).toContain("packages/agentcert-dashboard/public/data/monitor.json");
    expect(profile.run?.gate?.failOnVerdict).toBe(false);
  });

  it("emits a default monitor snapshot for explicit artifact runs", () => {
    const profile = profileFromArtifactFlags({
      tripwire: ".tripwire/latest/tripwire-result.json",
      subject: "my-browser-agent",
    });

    expect(profile.run?.monitor?.outputs).toEqual([".agentcert/monitor/monitor.json"]);
    expect(profile.run?.dataset?.reviewedOutputs).toEqual([".agentcert/corpus/reviewed-failure-dataset.jsonl"]);
  });

  it("lets CI place the reviewed dataset beside the evidence bundle", () => {
    const profile = profileFromArtifactFlags({
      tripwire: ".tripwire/latest/tripwire-result.json",
      reviewedDatasetOut: ".agentcert/latest/reviewed-failure-dataset.jsonl",
    });

    expect(profile.run?.dataset?.reviewedOutputs).toEqual([".agentcert/latest/reviewed-failure-dataset.jsonl"]);
  });
});

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function createRunProfile(dir: string, failOnVerdict: boolean): Promise<AgentCertRunProfile> {
  const mcpbench = join(dir, "mcpbench-results.json");
  const tripwire = join(dir, "tripwire-result.json");
  const onegent = join(dir, "audit-packet.json");
  await writeFile(
    mcpbench,
    JSON.stringify({
      run_id: "mcpbench_pass",
      total_score: 100,
      passed: true,
      completed_at: "2026-01-01T00:00:00Z",
    }),
  );
  await writeFile(
    tripwire,
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      gate: { passed: false },
      summary: { overallScore: 0 },
      runs: [
        {
          runId: "tripwire_failed",
          scenarioName: "refund-form",
          faultName: "modal-overlay",
          status: "failed",
          startedAt: "2026-01-01T00:00:01Z",
          assertions: [{ type: "url_contains", pass: false, message: "Final URL should contain /success" }],
        },
      ],
    }),
  );
  await writeFile(
    onegent,
    JSON.stringify({
      actionIntent: { id: "act_1" },
      riskAssessment: { riskLevel: "HIGH" },
      approvalRequest: { status: "APPROVED" },
      verificationResult: { success: true, createdAt: "2026-01-01T00:00:02Z" },
    }),
  );

  return {
    schemaVersion: "1",
    subject: { name: "demo-agent", type: "agent" },
    artifacts: { mcpbench, tripwire, onegent },
    outputDir: join(dir, "report"),
    run: {
      corpus: { path: join(dir, "corpus.jsonl"), replace: true },
      monitor: { outputs: [join(dir, "monitor.json")] },
      dataset: { reviewedOutputs: [join(dir, "reviewed-dataset.jsonl")] },
      gate: { failOnVerdict },
    },
  };
}
