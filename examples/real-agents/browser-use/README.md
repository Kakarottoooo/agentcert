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
npm run tripwire:lab-browser-use
```

Tripwire writes:

- `public-demo/real-agent-robustness/evidence/browser-use/tripwire-result.json`
- `public-demo/real-agent-robustness/evidence/browser-use/tripwire-report.html`
- screenshots, DOM snapshots, traces, and JUnit XML

Then generate a unified AgentCert evidence bundle:

```powershell
npm run agentcert:build
node packages/agentcert-cli/dist/cli.js run `
  --tripwire public-demo/real-agent-robustness/evidence/browser-use/tripwire-result.json `
  --out .agentcert/browser-use-real-agent `
  --subject browser-use `
  --replace
```

## Limits

This is one public agent, one local task, one model/provider, and deterministic
localhost pages. It is not a claim that browser-use is unsafe. It is a
reproducible slice showing how browser agents behave when the page fights back.
