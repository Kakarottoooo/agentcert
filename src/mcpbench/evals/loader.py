"""YAML eval-suite loader."""

from __future__ import annotations

from pathlib import Path

import yaml

from mcpbench.models import EvalTask


def suite_path(name: str) -> Path:
    normalized = name.replace("-", "_")
    return Path(__file__).parent / "suites" / f"{normalized}.yaml"


def load_suite(name: str) -> list[EvalTask]:
    path = suite_path(name)
    if not path.exists():
        raise ValueError(f"Unknown eval suite '{name}'. Expected {path}.")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    tasks = raw.get("tasks", [])
    if not isinstance(tasks, list):
        raise ValueError(f"Eval suite {path} must contain a 'tasks' list.")
    return [EvalTask.model_validate({**task, "suite": raw.get("suite", name)}) for task in tasks]
