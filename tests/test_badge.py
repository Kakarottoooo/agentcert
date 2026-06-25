from __future__ import annotations

from mcpbench.reports.badge import render_badge_payload, render_badge_svg


def test_badge_generated() -> None:
    svg = render_badge_svg(score=87, label="MCPBench", passed=True)

    assert svg.startswith("<svg")
    assert "87/100" in svg


def test_badge_payload_generated() -> None:
    payload = render_badge_payload(score=62, passed=False)

    assert '"message": "62/100 not certified"' in payload
