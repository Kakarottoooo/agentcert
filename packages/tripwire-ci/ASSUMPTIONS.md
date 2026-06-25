# Assumptions

- Tripwire fully observes agents only when they connect to the Chromium instance exposed by `TRIPWIRE_CDP_URL`.
- The MVP uses deterministic assertions instead of LLM grading.
- Fault injection is scoped to Playwright route handling and DOM scripts in the controlled browser.
- Behavior diffing is a semi-live replay diff over recorded traces/results, not bit-level deterministic replay.
- The demo uses only localhost pages and Node's built-in HTTP server.
- The brittle demo is expected to score deterministically for the bundled fault suite. `npm run demo:repeat` treats any score variance across three runs as a failure; if future browser timing changes introduce tolerated variance, that tolerance must be documented in the script environment.
