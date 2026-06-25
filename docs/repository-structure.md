# Repository Structure

AgentCert keeps runtime engines separate and shared concepts central.

```text
src/mcpbench/
  Python implementation for MCP/tool benchmark, runtime monitor, reports, badges.

packages/tripwire-ci/
  TypeScript implementation for browser-agent CI gates using Playwright and CDP.

schemas/
  Shared AgentCert result and evidence schemas used by import/export adapters.

docs/
  Product lifecycle, architecture, policy, scoring, observability, and usage docs.

examples/
  MCPBench quickstarts, policies, traces, and generated reports.
```

## Design Rule

Shared concepts move up:

- result schema;
- evidence shape;
- report vocabulary;
- score levels;
- badge semantics;
- policy terminology.

Engine-specific implementation stays down:

- MCP stdio and tool-call monitoring stay in `src/mcpbench`;
- Playwright/CDP/browser fault injection stays in `packages/tripwire-ci`;
- future production approvals and audit hooks should live in `packages/onegent-runtime`.

This gives one product without forcing one runtime or one language.

