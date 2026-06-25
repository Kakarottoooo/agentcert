from __future__ import annotations

from mcpbench.evals.runner import scripted_events
from mcpbench.monitor.sequence import SequenceMonitor


def test_passing_trace_has_no_violations() -> None:
    result = SequenceMonitor().analyze(scripted_events(script="passing", suite="basic-tool-use"))

    assert result.violations == []
    assert result.passed


def test_failing_sensitive_to_public_trace() -> None:
    result = SequenceMonitor().analyze(
        scripted_events(script="failing-untrusted-to-sink", suite="untrusted-output")
    )

    assert any(
        violation.rule_id == "no_sensitive_to_external_sink" for violation in result.violations
    )
    assert not result.passed


def test_failing_untrusted_to_privileged_trace() -> None:
    result = SequenceMonitor().analyze(
        scripted_events(script="failing-untrusted-to-privileged", suite="permission-scope")
    )

    assert result.violations[0].taxonomy == "untrusted_to_privileged_tool"
