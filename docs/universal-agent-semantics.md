# Universal Agent Semantics & Coverage v0.1

AgentCert normalizes heterogeneous agent tool calls into one bounded semantic
contract. The contract answers four separate questions:

1. Was an execution observed?
2. Can AgentCert map it to a declared capability?
3. Was a side effect forced through a controlled gateway or isolated adapter?
4. Was the resulting system state independently verified?

These are separate claims. A producer event can establish observation and
recording. It cannot self-assert enforcement, verification, or independent
review.

## Capability manifest

`agentcert.capability_manifest.v0.1` declares:

- stable capability ID and version;
- domain and operations;
- side-effect class and affected resource types;
- required permissions and risk;
- idempotency and reversibility expectations;
- intended enforcement and verification boundaries;
- framework-specific aliases.

The JSON Schema is
[`schemas/agentcert-capability-manifest.schema.json`](../schemas/agentcert-capability-manifest.schema.json).
Project manifests may extend the registry but cannot replace built-in IDs.

## Built-in capability packs

The v0.1 registry contains five deliberately small packs:

| Pack | Capabilities |
| --- | --- |
| browser | navigate, interact, submit |
| coding | read, write, execute |
| data | query, mutate, export |
| messaging | read, send |
| finance | read, pay |

Unknown tools remain unknown. AgentCert does not force a low-confidence match
to make a coverage number look complete.

## Instrumentation

- TypeScript: `instrumentTool()` from `agentcert-sdk`.
- Python: `instrument_tool()` and `instrument_async_tool()` from
  `agentcert_sdk`.
- MCP: `AgentCertMcpToolRecorder` from `@agentcert/mcp-adapter`.

Each wrapper emits one invocation ID across started/completed/failed phases,
uses the existing run trace, and stores bounded input/output descriptors. Keys
matching token, secret, password, authorization, cookie, credential, or API
key patterns are redacted before hashing. Raw tool inputs and outputs are not
uploaded by these wrappers.

## Coverage semantics

The Hosted overview computes a bounded 7, 30, or 90-day snapshot:

- **Observed:** received capability events divided by received events plus
  explicitly declared drops. Uninstrumented paths remain unknowable.
- **Understood:** received capability events mapped to a manifest or a
  human-confirmed correction.
- **Enforced:** side-effecting executions backed by controlled Action records
  at `enforced` strength.
- **Verified:** side-effecting executions with an independently observed
  outcome.

Started and terminal events with the same run/invocation ID count as one
execution in domain and side-effect totals. Ordinary event payloads cannot
increase the enforced or verified numerator.

Evidence strength is conservative:

`reported -> recorded -> enforced -> outcome_verified -> independently_reviewed`

`independently_reviewed` is shown only when the current window is not
truncated, declares no dropped events, has no unknown capabilities, and every
observed side effect has outcome verification.

## Unknown capability review

Unknown observations are grouped by framework, observed name, and event type.
An owner, admin, or operator can map an unknown key to a registered capability
with confidence and rationale. The correction is project-scoped, attributed to
the reviewer, and reused in later snapshots.

An optional OpenAI-compatible classifier can propose a mapping. Suggestions
are advisory and are never persisted until a human confirms them.

```text
AGENTCERT_SEMANTIC_CLASSIFIER_API_KEY=provider-secret
AGENTCERT_SEMANTIC_CLASSIFIER_MODEL=classifier-model
AGENTCERT_SEMANTIC_CLASSIFIER_URL=https://provider.example/v1/chat/completions
AGENTCERT_SEMANTIC_CLASSIFIER_TIMEOUT_MS=15000
```

Configure the API key and model together. Leave both absent to disable the
classifier deterministically.

## Hosted API

- `GET /v1/projects/:projectId/semantics/coverage?days=30`
- `GET|POST /v1/projects/:projectId/semantics/manifests`
- `GET /v1/projects/:projectId/semantics/corrections`
- `POST /v1/projects/:projectId/semantics/unknown/:key/suggest`
- `POST /v1/projects/:projectId/semantics/unknown/:key/review`

Coverage reads require both run and action visibility. Registry writes and
human corrections require owner, admin, or operator membership.

## Non-claims

- Observation does not prove that every execution path was instrumented.
- An LLM classification does not authorize an action.
- A declared manifest does not prove least privilege.
- An event producer cannot prove its own enforcement or outcome.
- A complete semantic snapshot is scoped to its project and analysis window.

For stronger evidence, deploy the
[customer-owned collector gateway](customer-owned-collector-gateway.md) and
the controls in the [Action Assurance Protocol](action-assurance-protocol.md).
