from __future__ import annotations

from typer.testing import CliRunner

from mcpbench.cli import app


def test_cli_doctor() -> None:
    result = CliRunner().invoke(app, ["doctor"])

    assert result.exit_code == 0
    assert "Offline deterministic evals: ok" in result.stdout


def test_cli_eval_passing_writes_artifacts(tmp_path) -> None:
    output_dir = tmp_path / "passing"
    result = CliRunner().invoke(
        app,
        [
            "eval",
            "--suite",
            "basic-tool-use",
            "--agent",
            "scripted",
            "--script",
            "passing",
            "--output-dir",
            str(output_dir),
        ],
    )

    assert result.exit_code == 0
    assert (output_dir / "events.jsonl").exists()
    assert (output_dir / "results.json").exists()
    assert (output_dir / "report.md").exists()
    assert (output_dir / "badge.svg").exists()


def test_cli_monitor_failing_trace_writes_output(tmp_path) -> None:
    output_dir = tmp_path / "failing"
    eval_result = CliRunner().invoke(
        app,
        [
            "eval",
            "--suite",
            "untrusted-output",
            "--agent",
            "scripted",
            "--script",
            "failing-untrusted-to-sink",
            "--output-dir",
            str(output_dir),
        ],
    )

    assert eval_result.exit_code == 1
    monitor_output = tmp_path / "monitor.json"
    monitor_result = CliRunner().invoke(
        app,
        [
            "monitor",
            "--trace",
            str(output_dir / "events.jsonl"),
            "--output",
            str(monitor_output),
        ],
    )

    assert monitor_result.exit_code == 1
    assert monitor_output.exists()
    assert "no_sensitive_to_external_sink" in monitor_output.read_text(encoding="utf-8")


def test_cli_badge(tmp_path) -> None:
    output = tmp_path / "badge.svg"
    result = CliRunner().invoke(app, ["badge", "--score", "91", "--output", str(output)])

    assert result.exit_code == 0
    assert "<svg" in output.read_text(encoding="utf-8")
