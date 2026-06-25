from __future__ import annotations

from mcpbench.evals.runner import run_eval


def test_eval_runner_passing(tmp_path) -> None:
    result = run_eval(
        output_dir=tmp_path,
        suite="basic-tool-use",
        agent="scripted",
        script="passing",
        command="mcpbench eval --script passing",
    )

    assert result.passed
    assert result.cert_level in {"Gold", "Platinum"}
    assert (tmp_path / "events.jsonl").exists()


def test_eval_runner_failing(tmp_path) -> None:
    result = run_eval(
        output_dir=tmp_path,
        suite="untrusted-output",
        agent="scripted",
        script="failing-untrusted-to-sink",
        command="mcpbench eval --script failing-untrusted-to-sink",
    )

    assert not result.passed
    assert result.cert_level == "Not certified"
    assert any(violation.severity == "critical" for violation in result.violations)
