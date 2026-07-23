# AgentCert MCP Adapter

Expose AgentCert control-plane operations as MCP tools:

```json
{
  "mcpServers": {
    "agentcert": {
      "command": "npx",
      "args": ["-y", "@agentcert/mcp-adapter"],
      "env": {
        "AGENTCERT_BASE_URL": "https://agentcert.example.com",
        "AGENTCERT_PROJECT_ID": "project-id",
        "AGENTCERT_API_KEY": "ac_live_..."
      }
    }
  }
}
```

Tools:

- `agentcert_start_run`
- `agentcert_record_events`
- `agentcert_assess_action`
- `agentcert_get_action`
- `agentcert_verify_action`

The API key is project-scoped. Approval tools are intentionally absent because
an agent credential must not approve its own high-risk action.

For an existing MCP client, wrap outbound tool calls with
`AgentCertMcpToolRecorder`. It emits ordered semantic start/completion/failure
events and can bind a tool to an `agentcert.capability_manifest.v0.1` ID. Unknown
tools remain in the Hosted review queue until a human confirms their mapping.
