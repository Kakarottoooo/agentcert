"""Local SVG badge generation."""

from __future__ import annotations

import json
from html import escape


def badge_color(score: int, passed: bool) -> str:
    if not passed:
        return "#d73a49"
    if score >= 90:
        return "#2ea44f"
    if score >= 80:
        return "#dbab09"
    return "#f66a0a"


def render_badge_svg(score: int, label: str = "MCPBench", passed: bool | None = None) -> str:
    active_passed = score >= 80 if passed is None else passed
    status = f"{score}/100" if active_passed else f"{score}/100 not certified"
    left_width = max(70, 8 * len(label) + 16)
    right_width = max(70, 7 * len(status) + 16)
    total_width = left_width + right_width
    color = badge_color(score, active_passed)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="20" role="img" aria-label="{escape(label)}: {escape(status)}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="{total_width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="{left_width}" height="20" fill="#555"/>
    <rect x="{left_width}" width="{right_width}" height="20" fill="{color}"/>
    <rect width="{total_width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="{left_width / 2}" y="15">{escape(label)}</text>
    <text x="{left_width + right_width / 2}" y="15">{escape(status)}</text>
  </g>
</svg>
"""


def render_badge_payload(score: int, label: str = "MCPBench", passed: bool | None = None) -> str:
    active_passed = score >= 80 if passed is None else passed
    return json.dumps(
        {
            "schemaVersion": 1,
            "label": label,
            "message": f"{score}/100" if active_passed else f"{score}/100 not certified",
            "color": badge_color(score, active_passed),
        },
        indent=2,
    )
