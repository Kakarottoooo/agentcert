# AgentCert Tripwire Action

Run browser-agent robustness gates and emit a unified AgentCert evidence packet.

```yaml
- uses: Kakarottoooo/agentcert/actions/tripwire@v0
  with:
    config: tripwire.yml
    out: .tripwire/latest
    fail-under: "0.8"
    subject: my-browser-agent
```

Outputs:

- `.tripwire/latest/tripwire-result.json`
- `.tripwire/latest/tripwire-report.html`
- `.tripwire/latest/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.md`
- `.agentcert/latest/badge.svg`

The action installs and builds AgentCert from this repository at the requested
ref. The caller repository owns `tripwire.yml` and the agent command under test.
