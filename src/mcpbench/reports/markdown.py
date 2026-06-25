"""Markdown report rendering."""

from __future__ import annotations

from mcpbench.models import MonitorResult, RunResult


def render_markdown_report(
    result: RunResult,
    monitor_result: MonitorResult | None = None,
) -> str:
    violations = monitor_result.violations if monitor_result is not None else result.violations
    lines = [
        "# MCPBench / AgentCert Report",
        "",
        f"MCPBench: {result.total_score}/100",
        f"AgentCert: {result.cert_level}",
        f"Passed: {'yes' if result.passed else 'no'}",
        f"Critical violations: {sum(1 for item in violations if item.severity == 'critical')}",
        f"High violations: {sum(1 for item in violations if item.severity == 'high')}",
        "",
        "## Reproduce",
        "",
        f"`{result.command}`",
        "",
        "## Findings",
        "",
    ]
    if not violations:
        lines.extend(
            [
                "No critical or high runtime behavior-chain violations were detected.",
                "",
            ]
        )
    for violation in violations:
        lines.extend(
            [
                f"### {violation.rule_id} ({violation.severity})",
                "",
                violation.message,
                "",
                f"Taxonomy: `{violation.taxonomy}`",
                f"Evidence event ids: {', '.join(f'`{event_id}`' for event_id in violation.event_ids)}",
                "",
            ]
        )
        if violation.evidence:
            lines.append("Evidence:")
            for key, value in violation.evidence.items():
                lines.append(f"- `{key}`: `{value}`")
            lines.append("")
        if violation.suggested_fix:
            lines.extend(["Suggested fix:", "", violation.suggested_fix, ""])
    lines.extend(["## Scorers", ""])
    for scorer in result.scorer_results:
        lines.append(
            f"- `{scorer.name}`: {scorer.score}/100 ({'pass' if scorer.passed else 'fail'})"
        )
    lines.append("")
    lines.extend(
        [
            "## Safety Note",
            "",
            "This report is based on benign local synthetic fixtures. It is not a security guarantee.",
            "",
        ]
    )
    return "\n".join(lines)
