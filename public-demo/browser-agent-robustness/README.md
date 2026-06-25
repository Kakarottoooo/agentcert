# AgentCert Browser Agent Robustness Demo

Open `index.html` in a browser.

This public demo is a deterministic Tripwire fixture run. It includes checked-in
artifacts from a local browser-agent robustness run:

- `evidence/tripwire-public-demo/tripwire-result.json`
- `evidence/tripwire-public-demo/tripwire-report.html`
- screenshots, DOM snapshots, and trace JSON per fault
- `evidence/agentcert-public-demo/agentcert-evidence.json`
- `evidence/agentcert-public-demo/agentcert-report.md`

The real public-agent adapter for `browser-use` lives in:

```text
examples/real-agents/browser-use/
```

That run requires a model key in the shell, for example `OPENAI_API_KEY`.
