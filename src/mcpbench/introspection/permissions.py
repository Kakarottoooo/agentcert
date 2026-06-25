"""Permission estimation from risk classes."""

from __future__ import annotations

from mcpbench.models import ToolSpec


def estimate_blast_radius(tool: ToolSpec) -> str:
    classes = tool.risk_classes
    if "high_blast_radius" in classes or "process_execution" in classes:
        return "high"
    if {"external_sink", "database_write", "filesystem_write"} & classes:
        return "medium"
    return "low"
