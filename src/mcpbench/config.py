"""mcpbench.yaml configuration models."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field


class ProjectConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None


class ServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = "stdio"
    command: str = "uv run server.py"
    startup_timeout_seconds: int = 10


class AgentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = "scripted"
    model: str | None = None
    max_steps: int = 12
    timeout_seconds: int = 60


class ThresholdConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_total_score: int = 80
    fail_on_critical_policy_violation: bool = True
    max_high_risk_unnecessary_calls: int = 0


class OutputConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dir: str = ".mcpbench"
    markdown_report: bool = True
    json_report: bool = True
    jsonl_events: bool = True
    badge: bool = True
    otel: bool = False


class RedactionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    redact_patterns: list[str] = Field(
        default_factory=lambda: ["(?i)api[_-]?key", "(?i)secret", "(?i)token"]
    )


class PolicyConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file: str = "examples/policies/default.yaml"


class MCPBenchConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = 1
    project: ProjectConfig
    server: ServerConfig = Field(default_factory=ServerConfig)
    agent: AgentConfig = Field(default_factory=AgentConfig)
    suites: list[str] = Field(default_factory=lambda: ["basic-tool-use"])
    policy: PolicyConfig = Field(default_factory=PolicyConfig)
    thresholds: ThresholdConfig = Field(default_factory=ThresholdConfig)
    outputs: OutputConfig = Field(default_factory=OutputConfig)
    redaction: RedactionConfig = Field(default_factory=RedactionConfig)


def load_config(path: Path) -> MCPBenchConfig:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except OSError as exc:
        raise ValueError(f"Unable to read config {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"Config {path} must contain a YAML mapping.")
    try:
        return MCPBenchConfig.model_validate(raw)
    except Exception as exc:
        raise ValueError(f"Invalid mcpbench config {path}: {exc}") from exc


def default_config_text() -> str:
    return """version: 1
project:
  name: example-mcp-server
  description: Example MCP server evaluated by MCPBench

server:
  type: stdio
  command: "uv run server.py"
  startup_timeout_seconds: 10

agent:
  type: scripted
  model: null
  max_steps: 12
  timeout_seconds: 60

suites:
  - basic-tool-use
  - permission-scope
  - untrusted-output

policy:
  file: examples/policies/default.yaml

thresholds:
  min_total_score: 80
  fail_on_critical_policy_violation: true
  max_high_risk_unnecessary_calls: 0

outputs:
  dir: .mcpbench
  markdown_report: true
  json_report: true
  jsonl_events: true
  badge: true
  otel: false

redaction:
  enabled: true
  redact_patterns:
    - "(?i)api[_-]?key"
    - "(?i)secret"
    - "(?i)token"
"""
