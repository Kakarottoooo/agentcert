# AgentCert Real Agent Robustness Lab

Open `index.html` in a browser or use the hosted GitHub Pages page.

This lab compares browser agents against the same deterministic Tripwire fault
suite. The checked-in public snapshot includes deterministic reference agents
and keeps the `browser-use` public-agent adapter wired but marked as missing
until a user runs it locally with their own model key.

Included evidence:

- `evidence/lab-snapshot.json`
- `../../schemas/agentcert-robustness-lab.schema.json`
- `evidence/reference-robust/tripwire-result.json`
- `evidence/reference-robust/tripwire-report.html`
- screenshots, DOM snapshots, trace JSON, JUnit XML, and agent events for the robust reference run
- linked brittle reference evidence from `../browser-agent-robustness/evidence/tripwire-public-demo/`

Regenerate the checked-in reference evidence:

```powershell
npm run tripwire:lab-reference
npm run agentcert:lab-build
```

Run the real public-agent adapter:

```powershell
python -m venv .venv-browser-use
.\\.venv-browser-use\\Scripts\\python -m pip install --upgrade browser-use
$env:OPENAI_API_KEY = "<your key>"
npm --prefix packages/tripwire-ci run build
node packages/tripwire-ci/dist/cli.js run `
  -c examples/real-agents/browser-use/tripwire.browser-use.yml `
  --out .tripwire/browser-use-real-agent `
  --fail-under 0
npm run agentcert:lab-build
```
