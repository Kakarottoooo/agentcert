import path from "node:path";
import type { TraceDiff, TraceMetadata, TripwireResult } from "../types.js";
import { ensureDir, readJson, writeJson } from "../utils/files.js";
import { HtmlReport } from "../reports/HtmlReport.js";

type Comparable = TraceMetadata | TripwireResult;

export class TraceDiffer {
  static async compareFiles(baselinePath: string, currentPath: string, outDir: string): Promise<TraceDiff> {
    const baseline = await readJson<Comparable>(baselinePath);
    const current = await readJson<Comparable>(currentPath);
    const diff = this.compare(baseline, current, baselinePath, currentPath);
    await ensureDir(outDir);
    await writeJson(path.join(outDir, "trace-diff.json"), diff);
    await HtmlReport.writeDiffReport(diff, path.join(outDir, "trace-diff.html"));
    return diff;
  }

  static compare(baseline: Comparable, current: Comparable, baselinePath = "baseline", currentPath = "current"): TraceDiff {
    const baselineTrace = firstTrace(baseline);
    const currentTrace = firstTrace(current);
    const diff: TraceDiff = {
      baseline: baselinePath,
      current: currentPath,
      summary: "No behavior divergence detected in comparable fields."
    };

    if (baselineTrace && currentTrace) {
      const max = Math.max(baselineTrace.steps.length, currentTrace.steps.length);
      for (let index = 0; index < max; index += 1) {
        const left = baselineTrace.steps[index];
        const right = currentTrace.steps[index];
        if (!diff.firstUrlDifference && left?.url !== right?.url) {
          diff.firstUrlDifference = { stepIndex: index + 1, baseline: left?.url, current: right?.url };
        }
        if (!diff.firstDomHashDifference && left?.domHash !== right?.domHash) {
          diff.firstDomHashDifference = { stepIndex: index + 1, baseline: left?.domHash, current: right?.domHash };
        }
        if (!diff.firstTextHashDifference && left?.textHash !== right?.textHash) {
          diff.firstTextHashDifference = { stepIndex: index + 1, baseline: left?.textHash, current: right?.textHash };
        }
        if (diff.firstUrlDifference || diff.firstDomHashDifference || diff.firstTextHashDifference) break;
      }
    }

    if ("runs" in baseline && "runs" in current) {
      for (const currentRun of current.runs) {
        const previous = baseline.runs.find((run) => run.scenarioName === currentRun.scenarioName && run.faultName === currentRun.faultName);
        if (!previous) continue;
        const regression = currentRun.assertions.find((assertion) => {
          const old = previous.assertions.find((item) => item.type === assertion.type && item.expected === assertion.expected);
          return old?.pass === true && assertion.pass === false;
        });
        if (regression) {
          diff.firstAssertionRegression = { runId: currentRun.runId, assertion: regression };
          break;
        }
      }

      const oldDuration = baseline.runs.reduce((sum, run) => sum + run.durationMs, 0);
      const newDuration = current.runs.reduce((sum, run) => sum + run.durationMs, 0);
      if (oldDuration > 0 && newDuration / oldDuration >= 1.5) {
        diff.durationDifference = { baselineMs: oldDuration, currentMs: newDuration, ratio: newDuration / oldDuration };
      }
    }

    const first =
      diff.firstAssertionRegression ??
      diff.firstUrlDifference ??
      diff.firstTextHashDifference ??
      diff.firstDomHashDifference ??
      diff.durationDifference;
    if (first) diff.summary = "Behavior diff detected. See first divergent step or assertion regression.";
    return diff;
  }
}

function firstTrace(input: Comparable): TraceMetadata | undefined {
  if ("steps" in input) return input;
  return undefined;
}
