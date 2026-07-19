# AgentCert Tripwire Action

Run browser-agent robustness gates and emit a unified AgentCert evidence packet.

[AgentCert Hosted](https://agentcert.app/) |
[Public evidence](https://agentcert.app/evidence) |
[Private workspace](https://agentcert.app/app)

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
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: "22"

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
```

## Continuous assurance

Create and issue an assurance case in the Hosted workspace, check in the scope
file generated from that reviewed baseline, then bind CI runs to it. Keep the
project key in GitHub Secrets; do not place it in Action inputs.

```yaml
env:
  AGENTCERT_BASE_URL: https://agentcert.app
  AGENTCERT_PROJECT_ID: ${{ vars.AGENTCERT_PROJECT_ID }}
  AGENTCERT_API_KEY: ${{ secrets.AGENTCERT_API_KEY }}

steps:
  - uses: actions/checkout@v7
  - uses: Kakarottoooo/agentcert/actions/tripwire@v0
    with:
      config: tripwire.yml
      push-hosted: "true"
      assurance-case: ${{ vars.AGENTCERT_ASSURANCE_CASE_ID }}
      assurance-scope: agentcert.assurance-scope.json
      assurance-trigger: auto
      require-current: "auto"
      continuous-health-out: .agentcert/canary/generated-kit-health.json
```

`auto` maps pull requests to a prospective check, scheduled workflows to a
nightly authoritative check, and pushes/releases/manual dispatches to an
authoritative release check. A PR can warn about scope drift without changing
production status. Release and nightly drift changes the Hosted state to
`REVALIDATION_REQUIRED` and emits configured webhook/email alerts.
Release and nightly jobs also fail unless the resulting Hosted status is
`CURRENT`. The redacted `generated-kit-health.json` output records the Hosted
run/evidence identifiers, completeness, status transition, and
install-to-CURRENT timing without exposing the API key.

The three trigger-specific config inputs are optional. Each falls back to
`config`, so existing callers keep the same behavior. Teams can use a fast,
stable subset on pull requests, the reviewed release suite on main/release,
and an expanded suite with newly added scenarios on the nightly schedule.

```yaml
with:
  config: tripwire.yml
  pull-request-config: tripwire.pr.yml
  release-config: tripwire.release.yml
  nightly-config: tripwire.nightly.yml
```

Outputs:

- `.tripwire/latest/tripwire-result.json`
- `.tripwire/latest/tripwire-report.html`
- `.tripwire/latest/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/agentcert-report.html`
- `.agentcert/latest/badge.svg`
- `.agentcert/latest/monitor.json`
- `.agentcert/latest/reviewed-failure-dataset.jsonl`
- `.agentcert/latest/agentcert-run-manifest.json`
- `.agentcert/latest/agentcert-release-gate.json`
- `.agentcert/latest/agentcert-release-gate.html`
- `.agentcert/latest/agentcert-release-gate-junit.xml`
- `.agentcert/latest/release-gate-badge.svg`
- `.agentcert/canary/generated-kit-health.json` when continuous assurance is configured

The action installs and builds AgentCert from this repository at the requested
ref. The caller repository owns `tripwire.yml` and the agent command under test.
