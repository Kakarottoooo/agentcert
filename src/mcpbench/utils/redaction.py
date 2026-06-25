"""Redaction helpers for shareable traces and reports."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

DEFAULT_REDACTION_PATTERNS = [
    re.compile(r"(?i)api[_-]?key"),
    re.compile(r"(?i)secret"),
    re.compile(r"(?i)token"),
    re.compile(r"(?i)password"),
]


def is_sensitive_key(key: str, patterns: Sequence[re.Pattern[str]] | None = None) -> bool:
    active_patterns = patterns or DEFAULT_REDACTION_PATTERNS
    return any(pattern.search(key) for pattern in active_patterns)


def redact_value(
    value: Any, patterns: Sequence[re.Pattern[str]] | None = None
) -> tuple[Any, list[str]]:
    """Redact suspicious mapping keys while preserving safe synthetic canaries."""

    redactions: list[str] = []

    def walk(item: Any, path: str) -> Any:
        if isinstance(item, Mapping):
            cleaned: dict[str, Any] = {}
            for key, child in item.items():
                child_path = f"{path}.{key}" if path else str(key)
                if is_sensitive_key(str(key), patterns):
                    cleaned[str(key)] = "[REDACTED]"
                    redactions.append(child_path)
                else:
                    cleaned[str(key)] = walk(child, child_path)
            return cleaned
        if isinstance(item, list):
            return [walk(child, f"{path}[{index}]") for index, child in enumerate(item)]
        return item

    return walk(value, ""), redactions
