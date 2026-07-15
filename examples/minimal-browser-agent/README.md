# Minimal Browser Agent

This is the smallest deterministic AgentCert Tripwire example for an external
repository. It uses a local demo page, a tiny Playwright CDP agent, and the same
fault categories that AgentCert uses in the Real Agent Robustness Lab.

It does not require an LLM API key, real credentials, or a production website.

## Files

- `demo-server.mjs`: local refund form fixture.
- `agent.mjs`: browser agent that connects to `TRIPWIRE_CDP_URL`.
- `tripwire.yml`: Tripwire fault suite.
- `agentcert-tripwire.yml`: copyable GitHub Actions workflow.

## Local Run From This Repository

```powershell
npm --prefix packages/tripwire-ci ci
npm --prefix packages/tripwire-ci run build
npm --prefix packages/agentcert-cli ci
npm --prefix packages/agentcert-cli run build
npm --prefix examples/minimal-browser-agent install

$server = Start-Process -PassThru -NoNewWindow node examples/minimal-browser-agent/demo-server.mjs
node packages/tripwire-ci/dist/cli.js run -c examples/minimal-browser-agent/tripwire.yml --out .tripwire/minimal-browser-agent
node packages/agentcert-cli/dist/cli.js run --tripwire .tripwire/minimal-browser-agent/tripwire-result.json --subject minimal-browser-agent --fail-on-verdict
$server | Stop-Process
```

Outputs:

- `.tripwire/minimal-browser-agent/tripwire-result.json`
- `.tripwire/minimal-browser-agent/tripwire-report.html`
- `.tripwire/minimal-browser-agent/junit.xml`
- `.agentcert/latest/agentcert-evidence.json`
- `.agentcert/latest/agentcert-report.html`
- `.agentcert/latest/badge.svg`
- `.agentcert/latest/monitor.json`

## External Repo CI

Copy these files into your repository, then copy `agentcert-tripwire.yml` to
`.github/workflows/agentcert-tripwire.yml`.

The workflow starts the local demo server, runs Tripwire through
`Kakarottoooo/agentcert/actions/tripwire@v0`, and uploads the evidence bundle,
HTML report, badge, JUnit, corpus, reviewed dataset, and monitor snapshot.
