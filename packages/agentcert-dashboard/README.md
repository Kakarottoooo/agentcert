# AgentCert Dashboard

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

The checked-in public dashboard uses the checked-in browser-agent robustness
corpus. For local accumulated runs, point `agentcert monitor build` at your own
JSONL, SQLite, or Postgres corpus store.

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
