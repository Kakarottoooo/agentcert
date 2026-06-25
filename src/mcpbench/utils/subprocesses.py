"""Subprocess placeholders for future stdio adapters."""

from __future__ import annotations


class SubprocessUnavailableError(RuntimeError):
    """Raised when an adapter is not implemented for the current MVP."""
