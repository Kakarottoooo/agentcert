# Playwright ARIA Agent

This adapter is a small public Playwright/CDP baseline for the Real Agent
Robustness Lab. It connects to the Tripwire-controlled Chromium instance,
fills the local refund form by accessible labels, and clicks a submit-like
button by accessible name.

It is not an LLM agent and does not require a model key. It is included so the
lab has a reproducible public Playwright baseline beside browser-use and the
deterministic internal Tripwire agents.

Run from the repository root:

```powershell
npm run tripwire:lab-playwright-agent
```

Current checked-in result: `6/9` passed. The baseline passes clean,
modal-overlay, button-text-drift, layout-shift, prompt-injection-banner, and
slow-network. It fails misleading-button, disabled-submit, and HTTP failure.
