# AgentCert Real Agent Robustness Lab

Open `index.html` in a browser or use the hosted GitHub Pages page.

This lab compares browser agents against the same deterministic Tripwire fault
suite. The checked-in public snapshot includes deterministic Playwright/CDP
agents, a public Playwright ARIA baseline, browser-use, and Stagehand evidence.
Re-running a model-backed adapter requires the caller's own model key; keys are
never stored in the repository.

Included evidence:

- `evidence/lab-snapshot.json`
- `../../schemas/agentcert-robustness-lab.schema.json`
- `evidence/reference-robust/tripwire-result.json`
- `evidence/reference-robust/tripwire-report.html`
- `evidence/playwright-agent/tripwire-result.json`
- `evidence/playwright-agent/tripwire-report.html`
- screenshots, DOM snapshots, trace JSON, JUnit XML, and agent events for the robust reference run
- linked brittle reference evidence from `../browser-agent-robustness/evidence/tripwire-public-demo/`
- first-divergence metadata comparing each fault trace to that agent's clean trace
- taxonomy labels, reviewer confidence, and structured "why this label" rationale
  loaded from the AgentCert corpus review ledger when available

Regenerate the checked-in reference evidence:

```powershell
npm run tripwire:lab-reference
npm run tripwire:lab-playwright-agent
npm run agentcert:lab-build
```

Run the real public-agent adapter:

```powershell
python -m venv .venv-browser-use
.\\.venv-browser-use\\Scripts\\Activate.ps1
.\\.venv-browser-use\\Scripts\\python -m pip install --upgrade browser-use
$env:OPENAI_API_KEY = "<your key>"
npm run tripwire:lab-browser-use
```
