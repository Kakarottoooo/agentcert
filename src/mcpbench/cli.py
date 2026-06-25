"""MCPBench command line interface."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from mcpbench import __version__
from mcpbench.config import default_config_text
from mcpbench.evals.runner import run_eval
from mcpbench.examples.servers import duckdb_like_server, filesystem_server, github_like_server
from mcpbench.introspection.inspector import inspect_tools
from mcpbench.models import RunResult, ToolSpec
from mcpbench.monitor.policy import load_policy
from mcpbench.monitor.sequence import SequenceMonitor
from mcpbench.reports.badge import render_badge_payload, render_badge_svg
from mcpbench.reports.console import print_result
from mcpbench.reports.json_report import render_json_report
from mcpbench.reports.markdown import render_markdown_report
from mcpbench.telemetry.jsonl import read_jsonl_events
from mcpbench.utils.paths import ensure_parent

app = typer.Typer(
    help="MCPBench runtime behavior benchmark and AgentCert reporting CLI.",
    no_args_is_help=True,
)
console = Console()


@app.callback()
def main(
    version: Annotated[
        bool,
        typer.Option("--version", help="Show the MCPBench version and exit."),
    ] = False,
) -> None:
    if version:
        console.print(__version__)
        raise typer.Exit()


@app.command()
def inspect(
    server_command: Annotated[
        str | None,
        typer.Option("--server-command", help="Server command or example server path to inspect."),
    ] = None,
    output: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="Write JSON inspection output."),
    ] = None,
) -> None:
    """Inspect a tool registry and classify exposed tools."""

    tools = _example_tools_for(server_command)
    result = inspect_tools(tools)
    rendered = json.dumps(result, indent=2)
    if output is not None:
        ensure_parent(output)
        output.write_text(rendered + "\n", encoding="utf-8")
        console.print(f"Wrote inspection to {output}")
    else:
        console.print_json(rendered)


@app.command("eval")
def eval_command(
    server_command: Annotated[
        str | None,
        typer.Option(
            "--server-command", help="Server command. Offline examples are inferred by name."
        ),
    ] = None,
    suite: Annotated[
        str,
        typer.Option("--suite", help="Eval suite name."),
    ] = "basic-tool-use",
    agent: Annotated[
        str,
        typer.Option("--agent", help="Agent adapter: scripted or mock for the offline MVP."),
    ] = "scripted",
    script: Annotated[
        str,
        typer.Option(
            "--script",
            help=(
                "Deterministic script: passing, failing-untrusted-to-sink, "
                "failing-untrusted-to-privileged, or failing-retry-loop."
            ),
        ),
    ] = "passing",
    output_dir: Annotated[
        Path,
        typer.Option("--output-dir", help="Directory for events, results, report, and badge."),
    ] = Path(".mcpbench/run"),
) -> None:
    """Run a deterministic offline eval and write AgentCert artifacts."""

    command = (
        f"mcpbench eval --suite {suite} --agent {agent} --script {script} --output-dir {output_dir}"
    )
    if server_command:
        command += f" --server-command {server_command!r}"
    result = run_eval(
        output_dir=output_dir,
        suite=suite,
        agent=agent,
        script=script,
        command=command,
    )
    print_result(result)
    if not result.passed:
        raise typer.Exit(code=1)


@app.command()
def monitor(
    trace: Annotated[Path, typer.Option("--trace", help="JSONL trace to analyze.")],
    policy: Annotated[
        Path | None,
        typer.Option("--policy", help="Policy YAML file. Defaults to built-in policy."),
    ] = None,
    output: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="Write monitor JSON output."),
    ] = None,
) -> None:
    """Analyze an existing event JSONL trace for behavior-chain violations."""

    events = read_jsonl_events(trace)
    monitor_result = SequenceMonitor().analyze(events, policy=load_policy(policy))
    rendered = monitor_result.model_dump_json(indent=2)
    if output is not None:
        ensure_parent(output)
        output.write_text(rendered + "\n", encoding="utf-8")
        console.print(f"Wrote monitor result to {output}")
    else:
        console.print_json(rendered)
    if not monitor_result.passed:
        raise typer.Exit(code=1)


@app.command()
def report(
    input: Annotated[Path, typer.Option("--input", "-i", help="results.json input.")],
    format: Annotated[
        str,
        typer.Option("--format", help="Report format: markdown, json, or console."),
    ] = "markdown",
    output: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="Output file."),
    ] = None,
) -> None:
    """Render a report from results.json."""

    result = result_from_json(input)
    if format == "markdown":
        rendered = render_markdown_report(result)
    elif format == "json":
        rendered = render_json_report(result)
    elif format == "console":
        print_result(result)
        return
    else:
        raise typer.BadParameter("format must be markdown, json, or console")

    if output is not None:
        ensure_parent(output)
        output.write_text(rendered, encoding="utf-8")
        console.print(f"Wrote report to {output}")
    else:
        console.print(rendered)


@app.command()
def badge(
    score: Annotated[int, typer.Option("--score", min=0, max=100, help="Score from 0 to 100.")],
    label: Annotated[str, typer.Option("--label", help="Badge label.")] = "MCPBench",
    output: Annotated[
        Path | None,
        typer.Option("--output", "-o", help="Write SVG badge file."),
    ] = None,
    payload_output: Annotated[
        Path | None,
        typer.Option("--payload-output", help="Write shields.io JSON payload."),
    ] = None,
) -> None:
    """Generate a local SVG badge and optional JSON badge endpoint payload."""

    svg = render_badge_svg(score=score, label=label)
    if output is not None:
        ensure_parent(output)
        output.write_text(svg, encoding="utf-8")
        console.print(f"Wrote badge to {output}")
    else:
        console.print(svg)
    if payload_output is not None:
        ensure_parent(payload_output)
        payload_output.write_text(render_badge_payload(score=score, label=label), encoding="utf-8")
        console.print(f"Wrote badge payload to {payload_output}")


@app.command("init")
def init_command(
    output: Annotated[
        Path,
        typer.Option("--output", "-o", help="Config path to create."),
    ] = Path("mcpbench.yaml"),
) -> None:
    """Create a starter mcpbench.yaml config."""

    if output.exists():
        raise typer.BadParameter(f"{output} already exists")
    ensure_parent(output)
    output.write_text(default_config_text(), encoding="utf-8")
    console.print(f"Wrote starter config to {output}")


@app.command()
def doctor(
    server_command: Annotated[
        str | None,
        typer.Option("--server-command", help="Optional server command to display."),
    ] = None,
) -> None:
    """Check local environment and MVP feature availability."""

    console.print(f"MCPBench {__version__}")
    console.print("Python package import: ok")
    console.print("Offline deterministic evals: ok")
    console.print("Real MCP stdio adapter: planned")
    if server_command:
        console.print(f"Configured server command: {server_command}")


def result_from_json(path: Path) -> RunResult:
    return RunResult.model_validate(json.loads(path.read_text(encoding="utf-8")))


def _example_tools_for(server_command: str | None) -> list[ToolSpec]:
    command = (server_command or "github_like_server").lower()
    if "filesystem" in command:
        return filesystem_server.get_tool_specs()
    if "duckdb" in command or "sqlite" in command:
        return duckdb_like_server.get_tool_specs()
    return github_like_server.get_tool_specs()


if __name__ == "__main__":
    app()
