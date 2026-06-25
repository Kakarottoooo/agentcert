from __future__ import annotations

from mcpbench.cert.verdict import result_from_monitor
from mcpbench.models import MonitorResult, PolicyViolation
from mcpbench.reports.json_report import render_json_report
from mcpbench.reports.markdown import render_markdown_report


def test_markdown_report_contains_evidence_and_reproduce_command() -> None:
    monitor = MonitorResult(
        events_analyzed=2,
        violations=[
            PolicyViolation(
                rule_id="retry_loop",
                severity="medium",
                message="retry loop",
                event_ids=["evt_1", "evt_2", "evt_3"],
                evidence={"tool_name": "query_readonly"},
                taxonomy="retry_loop",
            )
        ],
    )
    result = result_from_monitor(monitor, run_id="run_report", command="mcpbench eval")

    markdown = render_markdown_report(result, monitor)

    assert "`mcpbench eval`" in markdown
    assert "`evt_1`" in markdown
    assert "`tool_name`: `query_readonly`" in markdown


def test_json_report_schema_stable() -> None:
    monitor = MonitorResult(events_analyzed=0)
    result = result_from_monitor(monitor, run_id="run_json", command="mcpbench monitor")

    rendered = render_json_report(result)

    assert '"run_id": "run_json"' in rendered
    assert '"total_score": 100' in rendered
