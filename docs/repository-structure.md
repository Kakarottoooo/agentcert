# Repository Structure

AgentCert keeps runtime engines separate and shared concepts central.

```text
src/mcpbench/
  Python implementation for MCP/tool benchmark, runtime monitor, reports, badges.

packages/tripwire-ci/
  TypeScript implementation for browser-agent CI gates using Playwright and CDP.

packages/onegent-runtime/
  TypeScript implementation for local runtime action policy, approval,
  verification, and audit demos.

packages/agentcert-cli/
  TypeScript implementation for unified evidence bundles and markdown reports.

schemas/
  Shared AgentCert result, evidence, and evidence bundle schemas.

scenarios/
  Failure scenario library for concrete agent failure modes.

docs/
  Product lifecycle, architecture, policy, standards mapping, scoring,
  observability, and usage docs.

examples/
  MCPBench and AgentCert quickstarts, policies, traces, and generated reports.
```

## Design Rule

Shared concepts move up:

- result schema;
- evidence shape;
- evidence bundle format;
- report vocabulary;
- score levels;
- badge semantics;
- policy terminology.

Engine-specific implementation stays down:

- MCP stdio and tool-call monitoring stay in `src/mcpbench`;
- Playwright/CDP/browser fault injection stays in `packages/tripwire-ci`;
- runtime approvals and audit hooks live in `packages/onegent-runtime`;
- unified evidence import/export lives in `packages/agentcert-cli`.

This gives one product without forcing one runtime or one language.
