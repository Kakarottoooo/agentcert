from __future__ import annotations

from mcpbench.monitor.canary import CanaryTracker, find_canaries
from mcpbench.monitor.events import make_event, make_tool_event_data


def test_canary_exact_match() -> None:
    assert find_canaries("x BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY y") == {
        "BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY"
    }


def test_canary_no_false_positive() -> None:
    assert find_canaries("BENIGN marker without eval marker shape") == set()


def test_sensitive_source_tracked() -> None:
    tracker = CanaryTracker()
    event = make_event(
        run_id="run_canary",
        sequence_index=1,
        event_type="tool_call_completed",
        actor="agent",
        data=make_tool_event_data(
            tool_name="read_secret",
            tool_call_id="call_secret",
            risk_classes={"source", "sensitive_source"},
            result_summary="BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY",
        ),
    )

    tracker.observe_source_event(event)

    assert "BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY" in tracker.known_sensitive_markers()
