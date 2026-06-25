import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunResult, TraceDiff, TripwireResult } from "../types.js";
import { ensureDir, escapeHtml } from "../utils/files.js";

export class HtmlReport {
  static async write(result: TripwireResult, file: string, diff?: TraceDiff): Promise<void> {
    await ensureDir(path.dirname(file));
    await writeFile(file, this.render(result, file, diff), "utf8");
  }

  static async writeDiffReport(diff: TraceDiff, file: string): Promise<void> {
    await ensureDir(path.dirname(file));
    await writeFile(
      file,
      `<!doctype html><html><head><meta charset="utf-8"><title>Tripwire Behavior Diff</title>${style()}</head><body><main><h1>Tripwire Behavior Diff</h1>${renderDiff(diff)}</main></body></html>`,
      "utf8"
    );
  }

  static render(result: TripwireResult, reportFile: string, diff?: TraceDiff): string {
    const reportDir = path.dirname(reportFile);
    const rows = result.runs.map((run, index) => scenarioRow(run, index)).join("\n");
    const details = result.runs.map((run, index) => runDetail(run, index, reportDir)).join("\n");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tripwire CI Report</title>
  ${style()}
</head>
<body>
<main>
  <header>
    <h1>Tripwire CI Report</h1>
    <p>${escapeHtml(result.project)} - ${escapeHtml(result.timestamp)}</p>
  </header>
  <section class="overview">
    <div><strong>${result.summary.totalScenarios}</strong><span>Scenarios</span></div>
    <div><strong>${result.summary.totalRuns}</strong><span>Runs</span></div>
    <div><strong>${result.summary.passedRuns}</strong><span>Passed</span></div>
    <div><strong>${result.summary.failedRuns}</strong><span>Failed</span></div>
    <div><strong>${result.summary.overallScore.toFixed(2)}</strong><span>Score</span></div>
    <div><strong>${result.gate.failUnder.toFixed(2)}</strong><span>Gate</span></div>
    <div><strong class="${result.gate.passed ? "pass" : "fail"}">${result.gate.passed ? "PASS" : "FAIL"}</strong><span>Status</span></div>
  </section>
  <section>
    <h2>Scenario Runs</h2>
    <table>
      <thead><tr><th>Scenario</th><th>Fault</th><th>Status</th><th>Duration</th><th>Assertions</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  ${diff ? `<section><h2>Behavior Diff</h2>${renderDiff(diff)}</section>` : ""}
  <section>
    <h2>Run Details</h2>
    ${details}
  </section>
</main>
</body>
</html>`;
    return sanitizeLocalPaths(html, result, reportFile);
  }
}

function scenarioRow(run: RunResult, index: number): string {
  const passed = run.assertions.filter((assertion) => assertion.pass).length;
  return `<tr>
    <td>${escapeHtml(run.scenarioName)}</td>
    <td>${escapeHtml(run.faultName)}</td>
    <td><span class="pill ${run.status === "passed" ? "pass" : "fail"}">${run.status}</span></td>
    <td>${run.durationMs}ms</td>
    <td>${passed}/${run.assertions.length}</td>
    <td><a href="#run-${index}">open</a></td>
  </tr>`;
}

function runDetail(run: RunResult, index: number, reportDir: string): string {
  const traceDir = path.dirname(path.resolve(reportDir, run.tracePath));
  const screenshots = run.stepCount > 0 ? filmstrip(run, traceDir, reportDir) : "";
  const timeline = run.stepCount > 0 ? stepTimeline(run, traceDir, reportDir) : "";
  return `<article id="run-${index}" class="run">
    <h3>${escapeHtml(run.scenarioName)} / ${escapeHtml(run.faultName)} <span class="pill ${run.status === "passed" ? "pass" : "fail"}">${run.status}</span></h3>
    <dl>
      <dt>Final URL</dt><dd>${escapeHtml(run.finalUrl)}</dd>
      <dt>Agent</dt><dd><code>${escapeHtml([run.agent.command, ...run.agent.args].join(" "))}</code></dd>
      <dt>Fault</dt><dd><pre>${escapeHtml(JSON.stringify(run.fault, null, 2))}</pre></dd>
    </dl>
    <h4>Assertions</h4>
    <ul>${run.assertions.map((item) => `<li class="${item.pass ? "pass-text" : "fail-text"}">${item.pass ? "PASS" : "FAIL"} - ${escapeHtml(item.type)} - ${escapeHtml(item.message)} <small>${escapeHtml(item.observed ?? "")}</small></li>`).join("")}</ul>
    ${run.warnings.length ? `<h4>Warnings</h4><pre>${escapeHtml(run.warnings.join("\n"))}</pre>` : ""}
    ${run.diagnostics.length ? `<h4>Diagnostics</h4><pre>${escapeHtml(run.diagnostics.join("\n"))}</pre>` : ""}
    ${run.consoleErrors.length ? `<h4>Console Errors</h4><pre>${escapeHtml(run.consoleErrors.join("\n"))}</pre>` : ""}
    ${run.networkErrors.length ? `<h4>Network Errors</h4><pre>${escapeHtml(run.networkErrors.join("\n"))}</pre>` : ""}
    <h4>Screenshot Filmstrip</h4>
    <div class="filmstrip">${screenshots}</div>
    <h4>Step Timeline</h4>
    <ol class="timeline">${timeline}</ol>
    <h4>Trace</h4>
    <p><a href="${escapeHtml(run.tracePath)}">trace.json</a></p>
  </article>`;
}

function filmstrip(run: RunResult, traceDir: string, reportDir: string): string {
  const images: string[] = [];
  for (let i = 1; i <= run.stepCount; i += 1) {
    const screenshot = path.join(traceDir, "screenshots", `${String(i).padStart(4, "0")}.png`);
    const rel = path.relative(reportDir, screenshot).split(path.sep).join("/");
    images.push(`<figure><img src="${escapeHtml(rel)}" alt="Step ${i}"><figcaption>Step ${i}</figcaption></figure>`);
  }
  return images.join("\n");
}

function stepTimeline(run: RunResult, traceDir: string, reportDir: string): string {
  const steps: string[] = [];
  for (let i = 1; i <= run.stepCount; i += 1) {
    const id = String(i).padStart(4, "0");
    const screenshot = path.relative(reportDir, path.join(traceDir, "screenshots", `${id}.png`)).split(path.sep).join("/");
    const dom = path.relative(reportDir, path.join(traceDir, "dom", `${id}.html`)).split(path.sep).join("/");
    steps.push(
      `<li>Step ${i}: <a href="${escapeHtml(screenshot)}">screenshot</a> - <a href="${escapeHtml(dom)}">DOM snapshot</a></li>`
    );
  }
  return steps.join("\n");
}

function renderDiff(diff: TraceDiff): string {
  return `<div class="diff">
    <p>${escapeHtml(diff.summary)}</p>
    ${diff.firstUrlDifference ? `<p><strong>First URL difference:</strong> step ${diff.firstUrlDifference.stepIndex}<br>Baseline: ${escapeHtml(diff.firstUrlDifference.baseline)}<br>Current: ${escapeHtml(diff.firstUrlDifference.current)}</p>` : ""}
    ${diff.firstTextHashDifference ? `<p><strong>First text hash difference:</strong> step ${diff.firstTextHashDifference.stepIndex}</p>` : ""}
    ${diff.firstDomHashDifference ? `<p><strong>First DOM hash difference:</strong> step ${diff.firstDomHashDifference.stepIndex}</p>` : ""}
    ${diff.firstAssertionRegression ? `<p><strong>Assertion regression:</strong> ${escapeHtml(diff.firstAssertionRegression.assertion.type)} - ${escapeHtml(diff.firstAssertionRegression.assertion.message)}</p>` : ""}
    ${diff.durationDifference ? `<p><strong>Duration changed:</strong> ${diff.durationDifference.baselineMs}ms → ${diff.durationDifference.currentMs}ms</p>` : ""}
  </div>`;
}

function style(): string {
  return `<style>
body{margin:0;background:#f6f8fb;color:#172033;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 60px}
h1,h2,h3{letter-spacing:0;margin:0 0 10px} header{margin-bottom:24px}
header p{color:#526071;margin:0}.overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:20px 0}
.overview div{background:white;border:1px solid #dbe3ee;border-radius:8px;padding:14px}.overview strong{display:block;font-size:24px}.overview span{color:#526071}
table{width:100%;border-collapse:collapse;background:white;border:1px solid #dbe3ee;border-radius:8px;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid #e6edf5}th{background:#edf3f8}
.pill{display:inline-block;border-radius:999px;padding:3px 9px;font-size:12px;text-transform:uppercase;font-weight:700}.pass{color:#166534}.fail{color:#991b1b}.pill.pass{background:#dcfce7}.pill.fail{background:#fee2e2}
.run{margin-top:18px;background:white;border:1px solid #dbe3ee;border-radius:8px;padding:18px}dt{font-weight:700}dd{margin:0 0 10px}pre{white-space:pre-wrap;overflow:auto;background:#111827;color:#f9fafb;padding:12px;border-radius:6px}
.filmstrip{display:flex;gap:10px;overflow-x:auto}.filmstrip figure{margin:0;min-width:180px}.filmstrip img{width:180px;border:1px solid #dbe3ee;border-radius:6px;background:white}.filmstrip figcaption{font-size:12px;color:#526071}.timeline{line-height:1.8}.pass-text{color:#166534}.fail-text{color:#991b1b}small{display:block;color:#526071}
a{color:#075985}code{background:#eef2f7;padding:2px 5px;border-radius:4px}.diff{background:#fff;border:1px solid #dbe3ee;border-radius:8px;padding:14px}
</style>`;
}

function sanitizeLocalPaths(html: string, result: TripwireResult, reportFile: string): string {
  const roots = [process.cwd(), result.outDir, path.dirname(reportFile)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let sanitized = html;
  for (const root of roots) {
    sanitized = sanitized.split(root).join(".");
  }
  return sanitized;
}
