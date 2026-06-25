# MCP Tool-Call Trace Mapping Notes

Candidate attributes:

- `mcp.tool.name`
- `mcp.tool.call_id`
- `mcp.tool.arguments_hash`
- `mcp.tool.result_hash`
- `mcp.tool.result_size_bytes`
- `mcp.tool.risk_class`
- `mcp.tool.source_trust`
- `mcp.tool.sink_type`
- `mcp.tool.error_type`

Raw secrets should not be stored in spans. Prefer hashes, summaries, and explicit redaction metadata.

