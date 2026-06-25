# AgentCert CLI

Unified evidence, corpus, monitor, and lab CLI for AgentCert.

After the package is published, the intended low-friction entrypoint is:

```bash
npx agentcert run --tripwire .tripwire/latest/tripwire-result.json --out .agentcert/latest --subject my-agent --fail-on-verdict
```

Core outputs:

- `agentcert-evidence.json`
- `agentcert-report.md`
- `agentcert-run-manifest.json`
- `badge.svg`
- optional corpus and monitor snapshots

For local development inside this repository:

```bash
npm --prefix packages/agentcert-cli ci
npm --prefix packages/agentcert-cli run build
node packages/agentcert-cli/dist/cli.js run --profile public-demo
```
