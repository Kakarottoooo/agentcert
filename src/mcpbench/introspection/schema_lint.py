"""Deterministic schema-quality linting."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from mcpbench.introspection.risk_classifier import classify_tool
from mcpbench.models import Severity, ToolSpec


class LintWarning(BaseModel):
    model_config = ConfigDict(extra="forbid")

    severity: Severity
    code: str
    message: str
    evidence: dict[str, Any] = {}


def lint_tool_schema(tool: ToolSpec) -> list[LintWarning]:
    warnings: list[LintWarning] = []
    description = (tool.description or "").strip()
    classes = set(tool.risk_classes) | classify_tool(tool.name, tool.description, tool.input_schema)
    properties = tool.input_schema.get("properties", {})

    if "process_execution" in classes:
        warnings.append(
            LintWarning(
                severity="high",
                code="process_execution_high_blast_radius",
                message="Process execution tools require explicit scope and confirmation semantics.",
            )
        )
    if "high_blast_radius" in classes and not _mentions_scope(description):
        warnings.append(
            LintWarning(
                severity="high",
                code="missing_scope_constraints",
                message="High-risk tool description does not explain scope boundaries.",
            )
        )
    if len(description.split()) < 6:
        warnings.append(
            LintWarning(
                severity="medium",
                code="vague_description",
                message="Tool description is too vague for reliable agent selection.",
            )
        )
    ambiguous = sorted(
        name for name in properties if str(name).lower() in {"cmd", "sql", "input", "data", "path"}
    )
    if ambiguous:
        warnings.append(
            LintWarning(
                severity="medium",
                code="ambiguous_parameter_name",
                message="Input parameters should describe scope and semantics.",
                evidence={"parameters": ambiguous},
            )
        )
    if "database_read" in classes and "sql" in {str(name).lower() for name in properties}:
        lower_description = description.lower()
        for code, message in [
            ("sql_scope_unclear", "SQL scope is unclear."),
            ("missing_table_allowlist", "Database query tool lacks table allowlist guidance."),
            ("missing_result_size_guidance", "Database query tool lacks result-size guidance."),
            ("missing_error_model", "Database query tool lacks a structured error model."),
        ]:
            if code.split("_")[0] not in lower_description:
                warnings.append(LintWarning(severity="medium", code=code, message=message))
    return warnings


def _mentions_scope(description: str) -> bool:
    lower = description.lower()
    return any(
        token in lower for token in ("scope", "allowlist", "read-only", "confirmation", "within")
    )
