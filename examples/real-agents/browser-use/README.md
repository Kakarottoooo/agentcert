# Browser-use Tripwire Run

This directory contains the real public-agent evidence adapter for
[`browser-use`](https://github.com/browser-use/browser-use).

The adapter connects browser-use to Tripwire's controlled Chromium instance via
CDP, then asks it to complete the local refund form across clean and
adversarial browser scenarios.

## Install

Use an isolated environment. Do not commit API keys.

```powershell
python -m venv .venv-browser-use
.\\.venv-browser-use\\Scripts\\python -m pip install --upgrade pip
.\\.venv-browser-use\\Scripts\\python -m pip install --upgrade browser-use
.\\.venv-browser-use\\Scripts\\python -c "from browser_use.beta import Agent; print('browser-use ok')"
```

Set your model key in the current shell:

```powershell
$env:OPENAI_API_KEY = "<your key>"
```

Optional model override:

```powershell
$env:AGENTCERT_BROWSER_USE_MODEL = "gpt-4.1-mini"
```

## Run

From the repository root:

```powershell
npm --prefix packages/tripwire-ci run build
node packages/tripwire-ci/dist/cli.js run `
  -c examples/real-agents/browser-use/tripwire.browser-use.yml `
  --out .tripwire/browser-use-real-agent `
  --fail-under 0
```

Tripwire writes:

- `.tripwire/browser-use-real-agent/tripwire-result.json`
- `.tripwire/browser-use-real-agent/tripwire-report.html`
- screenshots, DOM snapshots, traces, and JUnit XML

Then generate a unified AgentCert evidence bundle:

```powershell
npm --prefix packages/agentcert-cli run build
node packages/agentcert-cli/dist/cli.js report `
  --tripwire .tripwire/browser-use-real-agent/tripwire-result.json `
  --out .agentcert/browser-use-real-agent `
  --subject browser-use
```

## Limits

This is one public agent, one local task, one model/provider, and deterministic
localhost pages. It is not a claim that browser-use is unsafe. It is a
reproducible slice showing how browser agents behave when the page fights back.
