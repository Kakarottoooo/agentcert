# Tripwire CI

Tripwire CI is the browser/computer-use agent gate inside AgentCert.

It is intentionally implemented as a TypeScript package because the browser harness depends on Playwright, CDP, DOM mutation, screenshots, and Node-based process control.

## What It Tests

- modal overlays;
- slow network responses;
- HTTP failures;
- changed button text;
- prompt injection banners;
- agent failure to connect to the provided CDP browser;
- deterministic success assertions.

## Outputs

- `tripwire-result.json`;
- `tripwire-report.html`;
- `junit.xml`;
- per-run `trace.json`;
- screenshots;
- DOM snapshots.

## Development

```powershell
npm --prefix packages/tripwire-ci ci
npm --prefix packages/tripwire-ci run build
npm --prefix packages/tripwire-ci test
```

Browser e2e:

```powershell
npx --prefix packages/tripwire-ci playwright install chromium
npm --prefix packages/tripwire-ci run test:e2e
```

