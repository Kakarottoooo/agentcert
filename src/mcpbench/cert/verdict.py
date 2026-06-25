"""Build stable RunResult verdicts from monitor output."""

from __future__ import annotations

from mcpbench.cert.levels import cert_level_for
from mcpbench.models import MonitorResult, RunResult
from mcpbench.scorers.aggregate import aggregate_score, scorer_results
from mcpbench.utils.time import deterministic_timestamp


def result_from_monitor(
    monitor_result: MonitorResult,
    *,
    run_id: str,
    command: str,
    artifact_paths: dict[str, str] | None = None,
) -> RunResult:
    score = aggregate_score(monitor_result)
    cert_level = cert_level_for(score, monitor_result)
    passed = cert_level != "Not certified" and monitor_result.high_count == 0
    return RunResult(
        run_id=run_id,
        total_score=score,
        cert_level=cert_level,
        passed=passed,
        violations=monitor_result.violations,
        scorer_results=scorer_results(monitor_result),
        artifact_paths=artifact_paths or {},
        command=command,
        started_at=deterministic_timestamp(0),
        completed_at=deterministic_timestamp(999),
    )
