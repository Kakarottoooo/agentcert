from __future__ import annotations

from mcpbench.introspection.risk_classifier import classify_tool, infer_source_trust


def test_risk_classifier_process_execution() -> None:
    classes = classify_tool(
        "run_command",
        "Run a command",
        {"type": "object", "properties": {"cmd": {"type": "string"}}},
    )

    assert "process_execution" in classes
    assert "high_blast_radius" in classes


def test_risk_classifier_untrusted_readme() -> None:
    classes = classify_tool("read_readme", "Read repository README content")

    assert "untrusted_source" in classes
    assert infer_source_trust(classes) == "untrusted"
