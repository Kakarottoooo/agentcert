"""AgentCert levels."""

from __future__ import annotations

from mcpbench.models import MonitorResult


def cert_level_for(score: int, monitor_result: MonitorResult) -> str:
    if monitor_result.critical_count > 0:
        return "Not certified"
    if score >= 95:
        return "Platinum"
    if score >= 90:
        return "Gold"
    if score >= 80:
        return "Silver"
    if score >= 70:
        return "Bronze"
    return "Not certified"
