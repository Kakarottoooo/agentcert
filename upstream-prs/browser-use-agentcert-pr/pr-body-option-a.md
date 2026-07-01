# PR body: docs: add AgentCert Tripwire to community integrations

Adds AgentCert Tripwire to the community integrations list, following the
format requested in `examples/integrations/README.md`.

**What it is:** an Apache-2.0 CI harness that launches a controlled Chromium,
hands browser-use a CDP endpoint, injects one realistic web fault per run
(modal overlay, button-text drift, decoy button, disabled submit, layout
shift, prompt-injection banner, slow network, HTTP 503), and grades each run
with deterministic assertions. Output per run: HTML report, JUnit, screenshots,
DOM snapshots, and a step-level trace — so a browser-use regression shows up on
the PR that caused it (prompt change, model swap, target-site drift).

**Why it may be useful to browser-use users:** we published a reproducible
robustness matrix over the same task and fault suite for five agents, and
browser-use currently has the best score (8/9), adapting through faults that
crashed scripted Playwright agents:
https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/

The adapter used for that published run is ~80 lines and connects through
`BrowserProfile(cdp_url=...)`:
https://github.com/Kakarottoooo/agentcert/tree/main/examples/real-agents/browser-use

No code is vendored into this repository; this is a listing only, per the
integrations README guidance. Happy to also contribute a small runnable
`examples/integrations/agentcert-tripwire/` example (uv setup, no secrets,
`ChatBrowserUse()` default) if maintainers would find that useful.
