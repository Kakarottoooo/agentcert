"""Stable hashing helpers."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Return a deterministic JSON representation for hashable evidence."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def stable_hash(value: Any) -> str:
    """Hash arbitrary JSON-compatible data with a stable short digest."""

    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()[:16]
