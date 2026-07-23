# Architecture

AgentCert is organized as a product with separate runtime engines and shared evidence/reporting concepts.

Current engines:

- `src/mcpbench`: Python MCP/tool benchmark and runtime sequence monitor.
- `packages/tripwire-ci`: TypeScript browser/computer-use agent robustness gate.
- `packages/onegent-runtime`: narrow action-assurance reference runtime with
  mandates, policy/approval, credential-isolated browser enforcement,
  independent outcome verification, and signed evidence.

Shared concepts live in docs and schemas first, then move into code when two or more engines need the same behavior.

## MCPBench Flow

MCPBench is organized around a normalized tool registry and a deterministic event stream.

Flow:

1. Adapter maps a server or fixture registry into `ToolSpec` models.
2. Eval runner emits typed JSONL `Event` records.
3. Sequence monitor replays events and produces `PolicyViolation` evidence.
4. Scorers convert monitor output into an AgentCert verdict.
5. Reporters render JSON, markdown, console summaries, and badges.

Boundaries:

- `adapters`: MCP stdio is implemented in `packages/agentcert-mcp-adapter`;
  additional remote/provider adapters remain workflow-driven work.
- `introspection`: schema linting, tool classification, and permission estimates.
- `monitor`: runtime sequence analysis, canary tracking, policy evaluation, and provenance.
- `evals`: deterministic tasks, suites, and scripted agents.
- `scorers`: explainable score components.
- `telemetry`: JSONL now, OpenTelemetry and OpenInference mappings later.
- `reports`: markdown, JSON, badge, and console outputs.

The stdio MCP adapter is intentionally not embedded in monitor logic. Real MCP protocol support will map external calls into the same internal event model.

## Tripwire CI Flow

Tripwire CI is organized around controlled browser execution:

1. Load `tripwire.yml`.
2. Start a controlled Chromium instance and expose a CDP endpoint.
3. Apply configured faults.
4. Run the agent command with `TRIPWIRE_CDP_URL` and artifact environment variables.
5. Capture screenshots, DOM snapshots, requests, console errors, and agent JSONL events.
6. Grade deterministic assertions.
7. Write `tripwire-result.json`, `tripwire-report.html`, `junit.xml`, and traces.

Tripwire stays in TypeScript because its natural runtime is Playwright/CDP.

## Onegent Runtime Boundary

Onegent Runtime supplies the reference action boundary used by AgentCert:

1. Receive proposed action.
2. Classify risk.
3. Evaluate policy.
4. Require approval when needed.
5. Execute, deny, or defer.
6. Verify result.
7. Write audit evidence.

The Hosted control plane signs short-lived execution grants and centrally
classifies submitted runtime evidence. Customer-owned gateways retain their
credentials and sign the source event chain. The public
`agentcert/browser-adapter-kit` subpath supplies a sandbox-only adapter and
conformance contract without exposing the private runtime as another product.

This layer shares AgentCert evidence vocabulary, but does not depend on
MCPBench or Tripwire internals. It does not claim hardware attestation or
prevent actions performed through credentials outside the registered gateway.
