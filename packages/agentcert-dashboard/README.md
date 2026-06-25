# AgentCert Dashboard

AgentCert Dashboard is the monitor UI for accumulated AgentCert corpus data.

Data flow:

```text
Tripwire / MCPBench / Onegent evidence
-> agentcert corpus ingest
-> corpus.jsonl
-> agentcert monitor build
-> public/data/monitor.json
-> Vite dashboard
```

Build the public monitor from the repository root:

```powershell
npm run agentcert:monitor-build
```

The build output is written to:

```text
public-demo/agentcert-monitor/
```

The checked-in public dashboard uses the checked-in browser-agent robustness
corpus. For local accumulated runs, point `agentcert monitor build` at your own
`.agentcert/corpus/corpus.jsonl`.

The monitor JSON shape is documented in:

```text
schemas/agentcert-monitor-snapshot.schema.json
```
