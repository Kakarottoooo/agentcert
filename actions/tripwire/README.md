# AgentCert Tripwire Action

Run browser-agent robustness gates and emit a unified AgentCert evidence packet.

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
```

Outputs:

- `.tripwire/latest/tripwire-result.json`
- `.tripwire/latest/tripwire-report.html`
- `.tripwire/latest/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/badge.svg`
- `.agentcert/latest/monitor.json`
- `.agentcert/latest/agentcert-run-manifest.json`

The action installs and builds AgentCert from this repository at the requested
ref. The caller repository owns `tripwire.yml` and the agent command under test.
