from __future__ import annotations

from mcpbench.config import default_config_text, load_config


def test_config_loading(tmp_path) -> None:
    path = tmp_path / "mcpbench.yaml"
    path.write_text(default_config_text(), encoding="utf-8")

    config = load_config(path)

    assert config.version == 1
    assert config.project.name == "example-mcp-server"
    assert "untrusted-output" in config.suites
