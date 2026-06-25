import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { AgentRunResult, FaultConfig, RunResult, ScenarioConfig, TraceMetadata, TripwireConfig, TripwireResult } from "../types.js";
import { BrowserSession } from "../browser/BrowserSession.js";
import { TraceRecorder } from "../capture/TraceRecorder.js";
import { FaultInjector } from "../faults/FaultInjector.js";
import { DeterministicGrader } from "../grading/DeterministicGrader.js";
import { JUnitReport } from "../reports/JUnitReport.js";
import { HtmlReport } from "../reports/HtmlReport.js";
import { cleanDir, ensureDir, relativePath, safeName, writeJson } from "../utils/files.js";
import { runAgentCommand } from "../utils/process.js";

export type RunOptions = {
  outDir: string;
  failUnder?: number;
  clean?: boolean;
};

export class TripwireRunner {
  constructor(private readonly config: TripwireConfig) {}

  async run(options: RunOptions): Promise<TripwireResult> {
    const outDir = path.resolve(options.outDir);
    if (options.clean ?? true) await cleanDir(outDir);
    else await ensureDir(outDir);

    const runs: RunResult[] = [];
    for (const scenario of this.config.scenarios) {
      for (const fault of scenario.faults) {
        runs.push(await this.runFault(outDir, scenario, fault));
      }
    }

    const failUnder = options.failUnder ?? this.config.gate.failUnder;
    const passedRuns = runs.filter((run) => run.status === "passed").length;
    const overallScore = runs.length ? passedRuns / runs.length : 0;
    const scenarioScores = this.config.scenarios.map((scenario) => {
      const scenarioRuns = runs.filter((run) => run.scenarioName === scenario.name);
      const passed = scenarioRuns.filter((run) => run.status === "passed").length;
      return {
        scenarioName: scenario.name,
        score: scenarioRuns.length ? passed / scenarioRuns.length : 0,
        passedRuns: passed,
        totalRuns: scenarioRuns.length
      };
    });
    const result: TripwireResult = {
      version: this.config.version,
      project: this.config.project,
      timestamp: new Date().toISOString(),
      outDir,
      gate: { failUnder, passed: overallScore >= failUnder },
      summary: {
        totalScenarios: this.config.scenarios.length,
        totalRuns: runs.length,
        passedRuns,
        failedRuns: runs.length - passedRuns,
        overallScore
      },
      scenarioScores,
      runs,
      warnings: runs.flatMap((run) => run.warnings.map((warning) => `${run.scenarioName}/${run.faultName}: ${warning}`))
    };

    await writeJson(path.join(outDir, "tripwire-result.json"), result);
    await HtmlReport.write(result, path.join(outDir, "tripwire-report.html"));
    await JUnitReport.write(result, path.join(outDir, "junit.xml"));
    return result;
  }

  private async runFault(outDir: string, scenario: ScenarioConfig, fault: FaultConfig): Promise<RunResult> {
    const runId = `${safeName(scenario.name)}-${safeName(fault.name)}-${Date.now().toString(36)}`;
    const runDir = path.join(outDir, "runs", safeName(scenario.name), safeName(fault.name));
    const artifactDir = path.join(runDir, "agent-artifacts");
    const eventsFile = path.join(runDir, "agent-events.jsonl");
    await ensureDir(artifactDir);
    await writeFile(eventsFile, "", "utf8");

    const startedAt = new Date().toISOString();
    const started = Date.now();
    const diagnostics: string[] = [];
    const warnings: string[] = [];
    if (scenario.capture.accessibilitySnapshots) {
      warnings.push("accessibilitySnapshots is accepted in config but is not implemented in this MVP.");
    }
    let trace: TraceMetadata | undefined;
    let finalUrl = scenario.startUrl;
    let agentResult: AgentRunResult = {
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 0
    };
    let session: BrowserSession | undefined;

    try {
      session = new BrowserSession({ headless: scenario.headless, startUrl: scenario.startUrl, timeoutMs: scenario.timeoutMs });
      const { cdpUrl, context, page } = await session.start();

      const injector = new FaultInjector(fault);
      try {
        await injector.applyBeforeNavigation(context, page);
      } catch (error) {
        if (fault.optional) warnings.push(`Optional fault failed before navigation: ${messageOf(error)}`);
        else throw new Error(`Fault failed before navigation: ${messageOf(error)}`);
      }

      await session.navigate();

      try {
        await injector.applyAfterNavigation(page);
      } catch (error) {
        if (fault.optional) warnings.push(`Optional fault failed after navigation: ${messageOf(error)}`);
        else throw new Error(`Fault failed after navigation: ${messageOf(error)}`);
      }

      const recorder = new TraceRecorder(page, {
        runId,
        scenarioName: scenario.name,
        fault,
        startUrl: scenario.startUrl,
        cdpUrl,
        runDir,
        capture: scenario.capture,
        eventsFile
      });
      await recorder.start();

      agentResult = await runAgentCommand(
        scenario.agent,
        {
          TRIPWIRE_CDP_URL: cdpUrl,
          TRIPWIRE_START_URL: scenario.startUrl,
          TRIPWIRE_RUN_ID: runId,
          TRIPWIRE_ARTIFACT_DIR: artifactDir,
          TRIPWIRE_EVENTS_FILE: eventsFile
        },
        scenario.timeoutMs
      );

      // Give the browser one short settling window so final navigation and DOM changes are captured.
      await page.waitForTimeout(250).catch(() => undefined);
      trace = await recorder.stop();
      finalUrl = page.url();
      warnings.push(...trace.warnings);

      const didNotAppearToConnect = agentResult.exitCode === 0 && finalUrl === scenario.startUrl && trace.steps.length <= 2;
      if (didNotAppearToConnect) {
        diagnostics.push(
          "Agent did not appear to connect to the provided CDP browser. Tripwire can fully observe only agents that use TRIPWIRE_CDP_URL."
        );
      }

      const assertions = await new DeterministicGrader(page).grade({
        assertions: scenario.success,
        trace,
        agentResult
      });
      if (didNotAppearToConnect) {
        assertions.push({
          type: "element_exists",
          expected: "agent CDP activity",
          pass: false,
          message: "Agent did not appear to connect to the provided CDP browser",
          observed: "No post-start navigation or meaningful trace activity was recorded"
        });
      }
      const status =
        assertions.every((assertion) => assertion.pass) && diagnostics.length === 0 && agentResult.exitCode === 0 && !agentResult.timedOut
          ? "passed"
          : "failed";

      return {
        runId,
        scenarioName: scenario.name,
        faultName: fault.name,
        fault,
        status,
        startedAt,
        durationMs: Date.now() - started,
        tracePath: relativePath(outDir, path.join(runDir, "trace.json")),
        artifactDir: relativePath(outDir, artifactDir),
        finalUrl,
        agent: scenario.agent,
        agentResult,
        assertions,
        warnings,
        diagnostics,
        consoleErrors: trace.consoleErrors,
        networkErrors: trace.networkErrors,
        requests: trace.requests,
        stepCount: trace.steps.length
      };
    } catch (error) {
      diagnostics.push(messageOf(error));
      const emptyTrace: TraceMetadata = {
        runId,
        scenarioName: scenario.name,
        fault,
        startUrl: scenario.startUrl,
        cdpUrl: session?.cdpUrl ?? "",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        requests: [],
        networkErrors: [],
        consoleErrors: [],
        steps: []
      };
      await writeJson(path.join(runDir, "trace.json"), emptyTrace);
      return {
        runId,
        scenarioName: scenario.name,
        faultName: fault.name,
        fault,
        status: "failed",
        startedAt,
        durationMs: Date.now() - started,
        tracePath: relativePath(outDir, path.join(runDir, "trace.json")),
        artifactDir: relativePath(outDir, artifactDir),
        finalUrl,
        agent: scenario.agent,
        agentResult,
        assertions: [
          {
            type: "url_contains",
            expected: "browser run completed",
            pass: false,
            message: "Run failed before deterministic grading completed",
            observed: diagnostics.join("\n")
          }
        ],
        warnings,
        diagnostics,
        consoleErrors: [],
        networkErrors: [],
        requests: [],
        stepCount: 0
      };
    } finally {
      await session?.close();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
