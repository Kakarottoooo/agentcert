# Tripwire CI

Tripwire CI is the browser/computer-use agent robustness gate inside AgentCert. It is kept as a TypeScript package because its runtime is Playwright, CDP, browser fault injection, and Node process control.

Tripwire CI is a local-first robustness gate for browser and computer-use agents. It launches a controlled Chromium browser, exposes a CDP endpoint to an agent command, injects realistic page faults, records trace artifacts, grades deterministic assertions, and exits non-zero when the robustness score falls below the configured gate.

## Quick Start

```bash
npm install
npx playwright install chromium
npm run build
npm run demo:tripwire
```

Open `.tripwire/latest/tripwire-report.html` to inspect the report.

## CLI

```bash
node dist/cli.js init
node dist/cli.js run -c examples/tripwire.yml --out .tripwire/latest
node dist/cli.js run -c examples/tripwire.yml --out .tripwire/latest --fail-under 0.8
node dist/cli.js compare --baseline old/tripwire-result.json --current .tripwire/latest/tripwire-result.json --out .tripwire/diff
node dist/cli.js report --input .tripwire/latest/tripwire-result.json --out .tripwire/latest/tripwire-report.html
node dist/cli.js version
```

## Agent Environment Contract

Tripwire passes these variables to the configured agent command:

- `TRIPWIRE_CDP_URL`
- `TRIPWIRE_START_URL`
- `TRIPWIRE_RUN_ID`
- `TRIPWIRE_ARTIFACT_DIR`
- `TRIPWIRE_EVENTS_FILE`

Agents should connect to `TRIPWIRE_CDP_URL`. If an agent launches its own browser and ignores the CDP URL, Tripwire cannot fully observe it and will warn when browser activity is suspiciously absent.

## Artifacts

Each run writes:

- `tripwire-result.json`
- `tripwire-report.html`
- `junit.xml`
- `runs/<scenario>/<fault>/trace.json`
- real PNG screenshots and HTML DOM snapshots

## Demo

`npm run demo:tripwire` starts the localhost refund app on `127.0.0.1:3020`, runs the brittle demo agent, and writes artifacts to `.tripwire/latest`.

`npm run demo:gate` runs the same scenario with a stricter `--fail-under 0.8` threshold and is expected to exit non-zero for the brittle agent. This command is intentionally an expected-failure gate demo.

`npm run demo:repeat` runs the brittle demo three times and fails if the score changes.

## GitHub Actions

The included composite action installs dependencies, optionally installs Playwright Chromium, builds Tripwire, runs the configured gate, and writes `$GITHUB_STEP_SUMMARY` with the overall score, pass/fail count, and report artifact path.

Example artifact upload:

```yaml
- uses: ./
  with:
    config: examples/tripwire.yml
    out: .tripwire/latest

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: tripwire-report
    path: .tripwire/latest
```
