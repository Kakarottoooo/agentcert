# Upstream PR Strategy

The first external validation target is one useful upstream PR, not a large benchmark claim.

## Week-One Targets

1. `modelcontextprotocol/servers`
   - Add a runtime tool-risk checklist for server maintainers.
   - Add benign untrusted-output fixture guidance.
   - Add schema examples for path scope, read-only mode, mutating tools, confirmation semantics, and redaction hints.

2. `modelcontextprotocol/python-sdk`
   - Add a tracing hook example around tool calls.
   - Add structured tool-call error example.
   - Add docs for mapping MCP tool calls to OpenTelemetry spans.

3. `modelcontextprotocol/typescript-sdk`
   - Add a server introspection example that prints stable tool metadata.
   - Add schema quality notes for tool descriptions and argument names.

4. Inspect AI or `inspect_evals`
   - Add an MCP tool-use reliability eval skeleton.
   - Add scorer examples for forbidden tool calls, wrong tool calls, bad arguments, and canary flow.

5. OpenTelemetry GenAI, OpenInference, or Phoenix examples
   - Add MCP tool-call trace examples.
   - Add JSONL-to-OTel conversion notes.

6. OpenAI Agents SDK examples
   - Contribute only if contribution guidelines and example fit are clear.

## Draft Assets In This Repo

- `upstream-prs/mcp-servers-runtime-tool-risk-checklist.md`
- `upstream-prs/mcp-sdk-otel-tool-call-example.py`
- `upstream-prs/inspect-evals-mcp-tool-use-skeleton.py`
- `upstream-prs/otel-mcp-tool-call-semconv-notes.md`

These assets avoid official-compatibility claims. They are designed as conservative starting points that upstream maintainers can adapt.

