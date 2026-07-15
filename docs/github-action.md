# GitHub Actions

Use AgentCert in CI as a set of checkpoints plus one unified evidence packet.

## MCPBench Gate

```yaml
name: MCPBench

on:
  pull_request:

jobs:
  mcpbench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -e ".[dev]"
      - run: mcpbench eval --suite basic-tool-use --agent scripted --script passing --output-dir .mcpbench/run
      - uses: actions/upload-artifact@v4
        with:
          name: mcpbench-report
          path: .mcpbench/run
```

Artifacts include `events.jsonl`, `results.json`, `report.md`, and `badge.svg`.

## Tripwire + Unified Evidence Packet

Use this when the caller repository has a `tripwire.yml` that launches the
browser or computer-use agent under test. The action runs Tripwire, then writes
the AgentCert evidence bundle, corpus, reviewed failure dataset, monitor
snapshot, badge, manifest, and JUnit/HTML reports.

Generate starter files:

```bash
npx agentcert init --subject my-browser-agent --github-action
```

```yaml
name: AgentCert Tripwire

on:
  pull_request:
  push:
    branches: [main]

jobs:
  tripwire:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: Kakarottoooo/agentcert/actions/tripwire@v0
        with:
          config: tripwire.yml
          out: .tripwire/latest
          fail-under: "0.8"
          subject: my-browser-agent
          agentcert-out: .agentcert/latest
          fail-on-verdict: "true"
          release-gate: "true"
          strict-release-gate: "false"
          # baseline: .agentcert/baselines/main.json
          # max-score-drop: "0"
```

Artifacts include:

- `.tripwire/latest/tripwire-result.json`
- `.tripwire/latest/tripwire-report.html`
- `.tripwire/latest/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.html`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-run-manifest.json`
- `.agentcert/latest/badge.svg`
- `.agentcert/latest/corpus.jsonl`
- `.agentcert/latest/reviewed-failure-dataset.jsonl`
- `.agentcert/latest/monitor.json`
- `.agentcert/latest/agentcert-release-gate.json`
- `.agentcert/latest/agentcert-release-gate.html`
- `.agentcert/latest/agentcert-release-gate-junit.xml`
- `.agentcert/latest/release-gate-badge.svg`

The release gate runs in advisory mode by default: failed automated evidence
blocks, while unconfigured manual controls remain visible. Set
`strict-release-gate: "true"` only after the repository has supplied the
required control attestations through `agentcert.config.json` or a separate
full release-gate job.

## Hosted Evidence Page + Clickable README Badge

Set `publish-pages: "true"` and the action pushes the Tripwire report, the
AgentCert HTML report, and the badge SVG to a GitHub Pages branch after every
run, then prints a ready-to-paste clickable badge for your README in the job
summary:

```yaml
jobs:
  tripwire:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: Kakarottoooo/agentcert/actions/tripwire@v0
        with:
          config: tripwire.yml
          subject: my-browser-agent
          publish-pages: "true"
          # pages-branch: gh-pages   (default)
          # pages-dir: agentcert     (default)
```

One-time setup: enable GitHub Pages for the `gh-pages` branch in the caller
repository settings (Settings -> Pages -> Deploy from a branch -> `gh-pages`).

The action then exposes:

- output `pages-url`: `https://<owner>.github.io/<repo>/agentcert`
- output `badge-markdown`:

```markdown
[![AgentCert](https://<owner>.github.io/<repo>/agentcert/latest/badge.svg)](https://<owner>.github.io/<repo>/agentcert/latest/agentcert-report.html)
```

The badge links to the hosted `agentcert-report.html`, and the full Tripwire
report (with screenshots, DOM snapshots, and traces) is published next to it at
`<pages-url>/tripwire/tripwire-report.html`. Evidence is published on both
passing and failing runs. That is the point of an evidence layer.
