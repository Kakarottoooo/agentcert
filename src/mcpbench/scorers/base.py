"""Scorer interface."""

from __future__ import annotations

from typing import Protocol

from mcpbench.models import ScorerResult


class Scorer(Protocol):
    def score(self) -> ScorerResult:
        """Produce an explainable score."""
