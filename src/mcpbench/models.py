"""Shared typed models for MCPBench."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer

SourceTrust = Literal["trusted", "untrusted", "mixed", "unknown"]
Severity = Literal["critical", "high", "medium", "low", "info"]


class ToolSpec(BaseModel):
    """Normalized representation of an agent-exposed tool."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    output_schema: dict[str, Any] | None = None
    risk_classes: set[str] = Field(default_factory=set)
    source_trust: SourceTrust = "unknown"
    annotations: dict[str, Any] = Field(default_factory=dict)

    @field_serializer("risk_classes")
    def serialize_risk_classes(self, value: set[str]) -> list[str]:
        return sorted(value)


class ToolCall(BaseModel):
    """Captured tool call summary."""

    model_config = ConfigDict(extra="forbid")

    id: str
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    result_summary: str | None = None
    result_hash: str | None = None
    latency_ms: int = 0
    error: str | None = None


class EvalTask(BaseModel):
    """A deterministic eval task definition."""

    model_config = ConfigDict(extra="forbid")

    id: str
    suite: str
    description: str
    user_prompt: str
    expected_tools: list[str] = Field(default_factory=list)
    forbidden_tools: list[str] = Field(default_factory=list)
    allowed_high_risk_tools: list[str] = Field(default_factory=list)
    canaries: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PolicyViolation(BaseModel):
    """Explainable policy violation linked to trace evidence."""

    model_config = ConfigDict(extra="forbid")

    rule_id: str
    severity: Severity
    message: str
    event_ids: list[str]
    evidence: dict[str, Any] = Field(default_factory=dict)
    suggested_fix: str | None = None
    taxonomy: str


class MonitorResult(BaseModel):
    """Result of replaying a trace through the sequence monitor."""

    model_config = ConfigDict(extra="forbid")

    events_analyzed: int
    violations: list[PolicyViolation] = Field(default_factory=list)

    @property
    def critical_count(self) -> int:
        return sum(1 for violation in self.violations if violation.severity == "critical")

    @property
    def high_count(self) -> int:
        return sum(1 for violation in self.violations if violation.severity == "high")

    @property
    def passed(self) -> bool:
        return self.critical_count == 0 and self.high_count == 0


class ScorerResult(BaseModel):
    """A single explainable scoring result."""

    model_config = ConfigDict(extra="forbid")

    name: str
    score: int = Field(ge=0, le=100)
    passed: bool
    evidence: dict[str, Any] = Field(default_factory=dict)


class RunResult(BaseModel):
    """Stable report input produced by evals or monitor/report commands."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    total_score: int = Field(ge=0, le=100)
    cert_level: str
    passed: bool
    violations: list[PolicyViolation] = Field(default_factory=list)
    scorer_results: list[ScorerResult] = Field(default_factory=list)
    artifact_paths: dict[str, str] = Field(default_factory=dict)
    command: str
    started_at: str
    completed_at: str
