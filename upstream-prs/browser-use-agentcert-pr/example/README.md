# AgentCert Tripwire × Browser Use

Run a Browser Use agent under injected web faults (popups, button drift, decoy
buttons, prompt-injection banners, slow network, HTTP failures) as a CI
regression gate. Each run is graded with deterministic assertions and produces
an HTML report, JUnit, screenshots, DOM snapshots, and a step-level trace.

[AgentCert Tripwire](https://github.com/Kakarottoooo/agentcert) launches a
controlled Chromium and hands your agent a CDP endpoint via
`TRIPWIRE_CDP_URL`. The agent in this example connects with
`BrowserProfile(cdp_url=...)`.

## Setup

```bash
uv venv
uv pip install browser-use
```

Required environment variables:

- `BROWSER_USE_API_KEY` (for `ChatBrowserUse()`), or edit the script to use
  another chat model.
- `TRIPWIRE_CDP_URL`, `TRIPWIRE_START_URL`, `TRIPWIRE_EVENTS_FILE` are injected
  by Tripwire; do not set them manually.

No secrets are committed; keys are read from the shell environment.

## Run in CI (recommended)

Copy `tripwire.yml` to your repository root, point `startUrl` at your app and
`agent.args` at this script, then add the workflow:

```yaml
- uses: Kakarottoooo/agentcert/actions/tripwire@v0
  with:
    config: tripwire.yml
    fail-under: "0.8"
    subject: my-browser-use-agent
```

The gate fails the PR when the agent's fault pass-rate drops below the
threshold, with full evidence attached as workflow artifacts.

## Run locally

From a checkout of the AgentCert repository:

```bash
npm --prefix packages/tripwire-ci ci
npm --prefix packages/tripwire-ci run build
npx --prefix packages/tripwire-ci playwright install chromium
node packages/tripwire-ci/dist/cli.js run -c tripwire.yml --out .tripwire/latest
```

Then open `.tripwire/latest/tripwire-report.html`.

## What this is not

One task and one fault suite are not a safety certification. The published
robustness matrix (where Browser Use currently scores 8/9 across five agents)
is here: https://kakarottoooo.github.io/agentcert/public-demo/real-agent-robustness/
