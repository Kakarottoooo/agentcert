import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { startDemoServer, type DemoServerHandle } from "../../examples/demo-server.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { TripwireRunner } from "../../src/runner/TripwireRunner.js";
import type { TripwireResult } from "../../src/types.js";

let server: DemoServerHandle;
let brittleOut = "";
let brittleScore = 0;
let brittleResult: TripwireResult;

describe("Tripwire demo", () => {
  beforeAll(async () => {
    server = await startDemoServer(3020);
  });

  afterAll(async () => {
    await server.close();
  });

  it("runs brittle agent, creates artifacts, and fails at least two injected faults", async () => {
    const config = await loadConfig(path.resolve("examples/tripwire.yml"));
    brittleOut = await mkdtemp(path.join(tmpdir(), "tripwire-brittle-"));
    const result = await new TripwireRunner(config).run({ outDir: brittleOut });
    brittleResult = result;
    brittleScore = result.summary.overallScore;
    const clean = result.runs.find((run) => run.faultName === "clean");
    const promptInjection = result.runs.find((run) => run.faultName === "prompt-injection-banner");
    expect(clean?.status).toBe("passed");
    expect(promptInjection?.assertions.some((assertion) => assertion.type === "no_sensitive_text_in_output")).toBe(true);
    expect(result.runs.filter((run) => run.status === "failed").length).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(brittleOut, "tripwire-result.json"))).toBe(true);
    expect(existsSync(path.join(brittleOut, "tripwire-report.html"))).toBe(true);
    expect(existsSync(path.join(brittleOut, "junit.xml"))).toBe(true);
  });

  it("exits non-zero when --fail-under is above brittle score", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tripwire-gate-"));
    const code = await runProcess(process.execPath, ["dist/cli.js", "run", "-c", "examples/tripwire.yml", "--out", out, "--fail-under", "0.8"]);
    expect(code).toBe(1);
  });

  it("robust agent scores greater than or equal to brittle agent", async () => {
    const brittleConfig = await loadConfig(path.resolve("examples/tripwire.yml"));
    const robustConfig = structuredClone(brittleConfig);
    robustConfig.scenarios[0].agent.args = ["examples/agents/robust-agent.mjs"];
    const robustOut = await mkdtemp(path.join(tmpdir(), "tripwire-robust-"));
    const robust = await new TripwireRunner(robustConfig).run({ outDir: robustOut });
    console.log(`Tripwire e2e scores: brittle=${brittleScore.toFixed(2)} robust=${robust.summary.overallScore.toFixed(2)}`);
    expect(robust.summary.overallScore).toBeGreaterThanOrEqual(brittleScore);
    expect(robust.runs.find((run) => run.faultName === "modal-overlay")?.status).toBe("passed");
    expect(robust.runs.find((run) => run.faultName === "button-text-drift")?.status).toBe("passed");
  });

  it("keeps report screenshot and DOM links portable after copying artifacts", async () => {
    const copied = await mkdtemp(path.join(tmpdir(), "tripwire-copy-"));
    await cp(brittleOut, copied, { recursive: true });
    const report = await readFile(path.join(copied, "tripwire-report.html"), "utf8");
    expect(report).not.toContain(process.cwd());
    expect(report).not.toContain("file://");

    const imageSrcs = [...report.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    expect(imageSrcs.length).toBeGreaterThan(0);
    for (const src of imageSrcs) {
      expect(path.isAbsolute(src)).toBe(false);
      expect(existsSync(path.join(copied, src))).toBe(true);
    }

    const domHrefs = [...report.matchAll(/href="([^"]+dom\/\d{4}\.html)"/g)].map((match) => match[1]);
    expect(domHrefs.length).toBeGreaterThan(0);
    for (const href of domHrefs) {
      expect(path.isAbsolute(href)).toBe(false);
      expect(existsSync(path.join(copied, href))).toBe(true);
    }
  });

  it("fails clearly when an agent ignores the provided CDP browser and warns for enabled accessibility snapshots", async () => {
    const config = await loadConfig(path.resolve("examples/tripwire.yml"));
    config.scenarios[0].agent.args = ["examples/agents/ignore-cdp-agent.mjs"];
    config.scenarios[0].faults = [{ name: "clean", type: "none" }];
    config.scenarios[0].capture.accessibilitySnapshots = true;
    config.scenarios[0].timeoutMs = 5000;
    const out = await mkdtemp(path.join(tmpdir(), "tripwire-ignore-cdp-"));
    const result = await new TripwireRunner(config).run({ outDir: out });
    const run = result.runs[0];
    expect(run.status).toBe("failed");
    expect(run.diagnostics.join("\n")).toContain("Agent did not appear to connect to the provided CDP browser");
    expect(run.warnings.join("\n")).toContain("accessibilitySnapshots is accepted in config but is not implemented in this MVP");
  });

  it("keeps the brittle demo score stable across three runs", async () => {
    const scores: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const config = await loadConfig(path.resolve("examples/tripwire.yml"));
      const out = await mkdtemp(path.join(tmpdir(), `tripwire-repeat-${index}-`));
      const result = await new TripwireRunner(config).run({ outDir: out });
      scores.push(result.summary.overallScore);
    }
    console.log(`Tripwire brittle repeat scores: ${scores.map((score) => score.toFixed(2)).join(", ")}`);
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(brittleResult.summary.overallScore);
  });
});

function runProcess(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  });
}
