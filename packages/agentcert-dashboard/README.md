# AgentCert Dashboard

The same React build serves the product site, public evidence, and authenticated
surfaces. AgentCert Hosted exposes the product site at `/`, the public snapshot
at `/evidence` without loading a user session or private API, and reserves
`/app` for the authenticated control plane. `/demo` remains an alias for old links.
In hosted control-plane mode, the authenticated workspace presents four primary
tasks: **Current Assurance**, **Release Assurance**, **Runtime Assurance**, and
**Evidence & Audit**. Detailed agent, integration, team, sandbox, and governance
views remain available under Setup or Advanced. The static corpus adapter remains
for the deterministic public evidence archive and does not own hosted review state.

AgentCert Dashboard is the monitor UI for accumulated AgentCert corpus data.

Data flow:

```text
Tripwire / MCPBench / Onegent evidence
-> agentcert corpus ingest
-> JSONL, SQLite, or Postgres corpus store
-> agentcert monitor build
-> public/data/monitor.json
-> Vite dashboard
```

Build the public monitor from the repository root:

```powershell
npm run agentcert:monitor-build
```

Run the local API-backed evidence console:

```powershell
npm run agentcert:serve
```

The build output is written to:

```text
public-demo/agentcert-monitor/
```

The checked-in public dashboard uses the checked-in lifecycle demo corpus:
MCPBench, Tripwire CI, and Onegent Runtime. For local accumulated runs, point
`agentcert monitor build` at your own JSONL, SQLite, or Postgres corpus store.

Failure taxonomy labels can be human-reviewed. Static GitHub Pages mode shows a
copyable `agentcert corpus review` command for each failure pattern. Local
server mode can write the review through `/api/runs/:id/failure-reviews`, append
to the review ledger, reapply reviews, and update the corpus store.
The review card captures reviewer confidence, first-divergence snippets,
screenshot/trace pointers, supporting signals, classifier limitations, and a
structured "why this label" rationale so the ledger can grow into a supervised
failure dataset.

When served through `agentcert serve`, the same React dashboard first calls
`/api/monitor` and `/api/runs/:id`. That enables run-level artifact inspection
without changing the static GitHub Pages build.

Examples:

```powershell
node packages/agentcert-cli/dist/cli.js monitor build --corpus .agentcert/corpus/corpus.jsonl --out packages/agentcert-dashboard/public/data/monitor.json --subject my-agent
node packages/agentcert-cli/dist/cli.js monitor build --store sqlite --sqlite .agentcert/corpus/agentcert.sqlite --out packages/agentcert-dashboard/public/data/monitor.json --subject my-agent
node packages/agentcert-cli/dist/cli.js monitor build --store postgres --database-url "$env:AGENTCERT_DATABASE_URL" --out packages/agentcert-dashboard/public/data/monitor.json --subject my-agent
```

The monitor JSON shape is documented in:

```text
schemas/agentcert-monitor-snapshot.schema.json
```
