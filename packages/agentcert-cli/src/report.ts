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
