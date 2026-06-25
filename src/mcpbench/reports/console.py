"""Console report helpers."""

from __future__ import annotations

from rich.console import Console

from mcpbench.models import RunResult


def print_result(result: RunResult) -> None:
    console = Console()
    console.print(f"MCPBench: [bold]{result.total_score}/100[/bold]")
    console.print(f"AgentCert: [bold]{result.cert_level}[/bold]")
    console.print(f"Passed: {'yes' if result.passed else 'no'}")
