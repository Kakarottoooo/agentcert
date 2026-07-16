# External agent templates

AgentCert uses one hosted project and one evidence model across agent types. Start from an empty repository:

```bash
npx agentcert init --template <browser|coding|mcp|workflow|data> --subject my-agent
```

| Template | Captured boundary | Generated integration |
| --- | --- | --- |
| `browser` | Browser task under deterministic UI and network faults | `tripwire.yml` and optional GitHub Action |
| `coding` | Proposed repository-changing action | Universal Event/Action Envelope adapter |
| `mcp` | MCP server/tool reliability result | MCPBench artifact profile |
| `workflow` | Durable workflow step or decision boundary | Universal Event/Action Envelope adapter |
| `data` | Query/analysis execution and verification boundary | Universal Event/Action Envelope adapter |

The generated adapters read credentials only from environment variables. They do not embed API keys or send arbitrary files. Full evidence should be uploaded at a deterministic verification point, not for every internal model token.
