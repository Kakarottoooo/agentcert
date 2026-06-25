"""Small policy engine facade around the sequence monitor."""

from __future__ import annotations

from collections.abc import Iterable

from mcpbench.models import EvalTask, MonitorResult, ToolSpec
from mcpbench.monitor.events import Event
from mcpbench.monitor.policy import Policy, default_policy
from mcpbench.monitor.sequence import SequenceMonitor


class PolicyEngine:
    def __init__(self, policy: Policy | None = None) -> None:
        self.policy = policy or default_policy()

    def analyze(
        self,
        events: Iterable[Event],
        *,
        task: EvalTask | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> MonitorResult:
        return SequenceMonitor().analyze(events, policy=self.policy, task=task, tools=tools)
