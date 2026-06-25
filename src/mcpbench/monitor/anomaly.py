"""Behavior anomaly helpers."""

from __future__ import annotations


def is_retry_loop(count: int, threshold: int) -> bool:
    return count >= threshold
