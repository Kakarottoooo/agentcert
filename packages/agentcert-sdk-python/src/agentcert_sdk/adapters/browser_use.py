from __future__ import annotations

from collections.abc import Awaitable, Callable, Sized
from typing import Any

from ..client import AgentCertClient
from ..envelope import event_envelope, new_trace_context


class BrowserUseAdapter:
    """Creates browser-use step hooks while recording only bounded, serializable state."""

    def __init__(
        self,
        client: AgentCertClient,
        *,
        agent_id: str,
        run_id: str,
        agent_version: str | None = None,
    ):
        self.client = client
        self.agent_id = agent_id
        self.run_id = run_id
        self.agent_version = agent_version
        self.sequence = 0
        self.trace = new_trace_context()

    def hooks(self) -> tuple[Callable[[Any], Awaitable[None]], Callable[[Any], Awaitable[None]]]:
        async def on_step_start(agent: Any) -> None:
            self.record("browser_use.step.started", agent)

        async def on_step_end(agent: Any) -> None:
            self.record("browser_use.step.ended", agent)

        return on_step_start, on_step_end

    def record(self, event_type: str, agent: Any) -> dict[str, Any]:
        state = _bounded_state(agent)
        envelope = event_envelope(
            agent_id=self.agent_id,
            agent_version=self.agent_version,
            run_id=self.run_id,
            event_type=event_type,
            sequence=self.sequence,
            attributes=state,
            trace=new_trace_context(self.trace),
            framework="browser-use",
            adapter="agentcert.browser_use.v0.1",
        )
        self.sequence += 1
        return self.client.send_envelope(envelope)


def _bounded_state(agent: Any) -> dict[str, Any]:
    state = getattr(agent, "state", None)
    history = getattr(agent, "history", None)
    return {
        "currentUrl": _text(
            getattr(state, "url", None) or getattr(agent, "current_url", None), 2048
        ),
        "lastAction": _text(getattr(state, "last_action", None), 1000),
        "lastResult": _text(getattr(state, "last_result", None), 2000),
        "historyLength": len(history) if isinstance(history, Sized) else None,
    }


def _text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    return str(value)[:limit]
