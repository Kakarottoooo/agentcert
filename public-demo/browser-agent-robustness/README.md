# AgentCert Browser Agent Robustness Demo

Open `index.html` in a browser.

This public demo explains the three AgentCert lifecycle gates, then shows one
interactive evidence slice from Tripwire CI:

- MCPBench before release: MCP servers, exposed tools, policy behavior, runtime traces.
- Tripwire CI before release: browser/computer-use agents under adversarial UI and network faults.
- Onegent Runtime after release: approval, verification, and audit for high-risk live actions.

The dashboard evidence is a deterministic Tripwire fixture run. It includes checked-in
artifacts from a local browser-agent robustness run:

- `evidence/tripwire-public-demo/tripwire-result.json`
- `evidence/tripwire-public-demo/tripwire-report.html`
- screenshots, DOM snapshots, and trace JSON per fault
- `evidence/agentcert-corpus.jsonl`
- `evidence/agentcert-public-demo/agentcert-evidence.json`
- `evidence/agentcert-public-demo/agentcert-report.md`

Current fixture result: 4 of 9 runs passed. Failed scenarios include modal
overlay, button text drift, misleading duplicate button, disabled submit, and
HTTP failure. Passing scenarios include clean, layout shift, prompt-injection
banner, and slow network.

The real public-agent adapter for `browser-use` lives in:

```text
examples/real-agents/browser-use/
```

That run requires a model key in the shell, for example `OPENAI_API_KEY`.
