"""Generate deterministic sample report artifacts."""

from __future__ import annotations

from pathlib import Path

from mcpbench.evals.runner import run_eval, write_sample_trace


def main() -> None:
    passing = run_eval(
        output_dir=Path("examples/reports/passing"),
        suite="basic-tool-use",
        agent="scripted",
        script="passing",
        command="python scripts/generate_sample_reports.py",
    )
    failing = run_eval(
        output_dir=Path("examples/reports/failing"),
        suite="untrusted-output",
        agent="scripted",
        script="failing-untrusted-to-sink",
        command="python scripts/generate_sample_reports.py",
    )
    write_sample_trace(Path("examples/traces/passing_run.jsonl"), "passing", "basic-tool-use")
    write_sample_trace(
        Path("examples/traces/failing_untrusted_to_sink.jsonl"),
        "failing-untrusted-to-sink",
        "untrusted-output",
    )
    Path("examples/reports/sample-report.md").write_text(
        Path("examples/reports/failing/report.md").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    print(f"Generated sample reports: passing={passing.total_score}, failing={failing.total_score}")


if __name__ == "__main__":
    main()
