import type { AgentCertBundle } from "./types.js";

export function renderMarkdownReport(bundle: AgentCertBundle): string {
  const lines: string[] = [
    "# AgentCert Evidence Report",
    "",
    `Subject: ${bundle.subject.name}`,
    `Generated: ${bundle.generatedAt}`,
    `Verdict: ${bundle.verdict.passed ? "PASS" : "FAIL"}`,
    `Score: ${bundle.verdict.score}`,
    `Level: ${bundle.verdict.level}`,
    "",
    "## Results",
    "",
  ];

  for (const result of bundle.results) {
    lines.push(
      `- ${result.product}: ${result.passed ? "PASS" : "FAIL"} (${result.score}/100, ${result.phase})`,
      `  ${result.summary ?? ""}`.trimEnd(),
    );
  }

  lines.push("", "## Evidence", "");
  if (bundle.evidence.length === 0) {
    lines.push("No blocking evidence recorded.");
  } else {
    for (const evidence of bundle.evidence) {
      lines.push(`- [${evidence.severity}] ${evidence.kind}: ${evidence.message}`);
    }
  }

  lines.push("", "## Standards Mapping", "");
  for (const standard of bundle.standards) {
    lines.push(`- ${standard.name}: ${standard.note}`);
  }

  lines.push("", "## Artifacts", "");
  for (const [name, path] of Object.entries(bundle.artifacts)) {
    lines.push(`- ${name}: \`${path}\``);
  }

  return `${lines.join("\n")}\n`;
}

export function renderHtmlReport(bundle: AgentCertBundle): string {
  const resultCards = bundle.results
    .map(
      (result) => `<article class="card ${result.passed ? "pass" : "fail"}">
        <span>${escapeHtml(result.phase)}</span>
        <h2>${escapeHtml(result.product)}</h2>
        <strong>${result.passed ? "PASS" : "FAIL"} ${result.score}/100</strong>
        <p>${escapeHtml(result.summary ?? "No summary provided.")}</p>
      </article>`,
    )
    .join("");
  const evidenceRows =
    bundle.evidence.length === 0
      ? `<tr><td colspan="4">No blocking evidence recorded.</td></tr>`
      : bundle.evidence
          .map(
            (evidence) => `<tr>
              <td><span class="severity ${escapeHtml(evidence.severity)}">${escapeHtml(evidence.severity)}</span></td>
              <td>${escapeHtml(evidence.kind)}</td>
              <td>${escapeHtml(evidence.message)}</td>
              <td>${evidence.artifactPath ? artifactLink(evidence.artifactPath) : "-"}</td>
            </tr>`,
          )
          .join("");
  const artifactRows = Object.entries(bundle.artifacts)
    .map(([name, path]) => `<tr><td>${escapeHtml(name)}</td><td>${artifactLink(path)}</td></tr>`)
    .join("");
  const standardItems = bundle.standards
    .map((standard) => `<li><strong>${escapeHtml(standard.name)}</strong><span>${escapeHtml(standard.note)}</span></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AgentCert Evidence Report</title>
    <style>
      :root { color-scheme: light; --ink: #102033; --muted: #5d6978; --line: #d9e0e8; --bg: #f6f8fb; --panel: #fff; --pass: #087f5b; --fail: #c92a2a; }
      body { margin: 0; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
      main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 48px; }
      header { display: grid; gap: 16px; margin-bottom: 24px; }
      h1 { margin: 0; font-size: clamp(32px, 6vw, 62px); line-height: 0.95; }
      h2 { margin: 0 0 10px; font-size: 18px; }
      p { color: var(--muted); margin: 0; }
      .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
      .metric, .card, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
      .metric span, .card span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 700; }
      .metric strong { display: block; margin-top: 8px; font-size: 28px; }
      .verdict-pass { color: var(--pass); }
      .verdict-fail { color: var(--fail); }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .card { border-left: 5px solid var(--line); }
      .card.pass { border-left-color: var(--pass); }
      .card.fail { border-left-color: var(--fail); }
      .card strong { display: block; margin: 8px 0; font-size: 20px; }
      section { margin-top: 16px; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 720px; }
      th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { font-size: 12px; text-transform: uppercase; color: var(--muted); }
      a { color: #0b63ce; text-decoration: none; font-weight: 650; }
      ul { margin: 0; padding-left: 20px; }
      li { margin: 8px 0; }
      li span { display: block; color: var(--muted); }
      .severity { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 800; color: #fff; background: #687385; }
      .severity.critical, .severity.high { background: var(--fail); }
      .severity.medium { background: #b35c00; }
      .severity.low, .severity.info { background: #24745a; }
      @media (max-width: 760px) { .summary { grid-template-columns: 1fr 1fr; } main { width: min(100% - 24px, 1120px); padding-top: 20px; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p>AgentCert Evidence Report</p>
        <h1>${escapeHtml(bundle.subject.name)}</h1>
        <p>Generated ${escapeHtml(bundle.generatedAt)}. Portable evidence bundle ${escapeHtml(bundle.runId)}.</p>
      </header>
      <div class="summary">
        <div class="metric"><span>Verdict</span><strong class="${bundle.verdict.passed ? "verdict-pass" : "verdict-fail"}">${bundle.verdict.passed ? "PASS" : "FAIL"}</strong></div>
        <div class="metric"><span>Score</span><strong>${bundle.verdict.score}/100</strong></div>
        <div class="metric"><span>Level</span><strong>${escapeHtml(bundle.verdict.level)}</strong></div>
        <div class="metric"><span>Evidence</span><strong>${bundle.summary.totalEvidence}</strong></div>
      </div>
      <div class="cards">${resultCards}</div>
      <section>
        <h2>Evidence</h2>
        <table>
          <thead><tr><th>Severity</th><th>Kind</th><th>Message</th><th>Artifact</th></tr></thead>
          <tbody>${evidenceRows}</tbody>
        </table>
      </section>
      <section>
        <h2>Artifacts</h2>
        <table>
          <thead><tr><th>Name</th><th>Path</th></tr></thead>
          <tbody>${artifactRows || `<tr><td colspan="2">No artifacts recorded.</td></tr>`}</tbody>
        </table>
      </section>
      <section>
        <h2>Standards Mapping</h2>
        <ul>${standardItems}</ul>
      </section>
    </main>
  </body>
</html>
`;
}

function artifactLink(path: string): string {
  const escaped = escapeHtml(path);
  return `<a href="${escapeHtml(path)}">${escaped}</a>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
