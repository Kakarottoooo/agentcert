import { writeFile } from "node:fs/promises";
import type { RunResult, TripwireResult } from "../types.js";
import { ensureDir, escapeHtml } from "../utils/files.js";
import path from "node:path";

export class JUnitReport {
  static async write(result: TripwireResult, file: string): Promise<void> {
    await ensureDir(path.dirname(file));
    await writeFile(file, this.render(result), "utf8");
  }

  static render(result: TripwireResult): string {
    const failures = result.runs.filter((run) => run.status === "failed").length;
    const cases = result.runs.map((run) => renderCase(run)).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeHtml(result.project)}" tests="${result.runs.length}" failures="${failures}" timestamp="${escapeHtml(result.timestamp)}">
${cases}
</testsuite>
`;
  }
}

function renderCase(run: RunResult): string {
  const name = `${run.scenarioName} / ${run.faultName}`;
  const seconds = (run.durationMs / 1000).toFixed(3);
  if (run.status === "passed") {
    return `  <testcase classname="${escapeHtml(run.scenarioName)}" name="${escapeHtml(name)}" time="${seconds}" />`;
  }
  const messages = [
    ...run.diagnostics,
    ...run.assertions.filter((assertion) => !assertion.pass).map((assertion) => `${assertion.type}: ${assertion.message}; observed=${assertion.observed ?? ""}`)
  ].join("\n");
  return `  <testcase classname="${escapeHtml(run.scenarioName)}" name="${escapeHtml(name)}" time="${seconds}">
    <failure message="${escapeHtml(name)} failed">${escapeHtml(messages)}</failure>
  </testcase>`;
}
