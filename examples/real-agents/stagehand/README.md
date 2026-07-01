# Stagehand Tripwire Run

This directory contains the real public-agent evidence adapter for
[Stagehand](https://github.com/browserbase/stagehand) (v3, `LOCAL` env).

The adapter connects Stagehand to Tripwire's controlled Chromium instance via
CDP, then asks its tool-based agent to complete the local refund form across
clean and adversarial browser scenarios.

## Install

Dependencies are local to this directory. Do not commit API keys.

```powershell
cd examples/real-agents/stagehand
npm install
```

Set your model key in the current shell:

```powershell
$env:OPENAI_API_KEY = "<your key>"
```

Optional model override (AI SDK `provider/model` format):

```powershell
$env:AGENTCERT_STAGEHAND_MODEL = "openai/gpt-4.1-mini"
```

## Run

From the repository root:

```powershell
npm run tripwire:lab-stagehand
```

Tripwire writes:

- `public-demo/real-agent-robustness/evidence/stagehand/tripwire-result.json`
- `public-demo/real-agent-robustness/evidence/stagehand/tripwire-report.html`
- screenshots, DOM snapshots, traces, and JUnit XML

## Limits

This is one public agent, one local task, one model/provider, and deterministic
localhost pages. It is not a claim that Stagehand is unsafe. It is a
reproducible slice showing how browser agents behave when the page fights back.
