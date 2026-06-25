"""Explainable conservative tool-risk classification heuristics."""

from __future__ import annotations

from typing import Any

from mcpbench.models import SourceTrust, ToolSpec


def classify_tool(
    name: str,
    description: str | None = None,
    input_schema: dict[str, Any] | None = None,
    *,
    overrides: dict[str, list[str]] | None = None,
) -> set[str]:
    text = f"{name} {description or ''}".lower()
    classes: set[str] = set()
    override_classes = set((overrides or {}).get(name, []))

    if any(token in text for token in ("read", "get", "list", "fetch", "query", "search")):
        classes.add("source")
    if any(
        token in text for token in ("readme", "webpage", "web page", "issue", "ticket", "comment")
    ):
        classes.update({"source", "untrusted_source"})
    if any(token in text for token in ("secret", "env", "token", "credential", "private")):
        classes.update({"source", "sensitive_source", "auth_sensitive"})
    if any(
        token in text for token in ("write", "delete", "update", "create", "post", "send", "upload")
    ):
        classes.update({"sink", "mutator"})
    if any(
        token in text
        for token in ("email", "http_post", "post_issue", "public", "upload", "webhook")
    ):
        classes.update({"sink", "external_sink", "public_sink", "network_write"})
    if any(token in text for token in ("file", "path", "directory", "repo")):
        if "write" in text or "delete" in text or "create" in text:
            classes.add("filesystem_write")
        if "read" in text or "list" in text:
            classes.add("filesystem_read")
    if any(token in text for token in ("database", "sql", "duckdb", "sqlite", "query")):
        if any(token in text for token in ("write", "update", "delete", "insert", "execute")):
            classes.add("database_write")
        else:
            classes.add("database_read")
    if any(token in text for token in ("run_command", "shell", "command", "exec", "process")):
        classes.update({"process_execution", "high_blast_radius"})
    if any(
        token in text for token in ("delete", "execute", "run_command", "send_email", "upload_file")
    ):
        classes.add("high_blast_radius")

    schema_text = str(input_schema or {}).lower()
    if "sql" in schema_text:
        classes.add("database_read")
    if any(token in schema_text for token in ("cmd", "command")):
        classes.update({"process_execution", "high_blast_radius"})

    classes.update(override_classes)
    if not classes:
        classes.add("low_risk")
    return classes


def infer_source_trust(risk_classes: set[str]) -> SourceTrust:
    if "untrusted_source" in risk_classes:
        return "untrusted"
    if "source" in risk_classes or "sensitive_source" in risk_classes:
        return "trusted"
    return "unknown"


def classify_tool_spec(tool: ToolSpec, overrides: dict[str, list[str]] | None = None) -> ToolSpec:
    classes = classify_tool(
        tool.name,
        tool.description,
        tool.input_schema,
        overrides=overrides,
    )
    return tool.model_copy(
        update={
            "risk_classes": set(tool.risk_classes) | classes,
            "source_trust": infer_source_trust(set(tool.risk_classes) | classes),
        }
    )
