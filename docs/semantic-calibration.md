# Semantic adapter calibration

AgentCert maps framework-specific tool events into a small, stable capability ontology. The deterministic golden dataset pins public tool contracts from five external projects:

| Capability pack | External project | Calibration evidence |
| --- | --- | --- |
| Browser | Browser Use | Checked-in real run plus pinned source contract |
| Coding | OpenHands | Pinned public tool contract |
| Data | LangChain Community SQLDatabaseToolkit | Pinned public tool contract |
| Messaging | Cloudflare Agents Email | Pinned public tool contract |
| Finance | Stripe Agent Toolkit and MCP | Pinned public tool contract |

Each adapter row includes the repository, exact git commit, source URL, observed tool name, expected AgentCert capability, and rationale. The dataset is [golden-v0.1.json](../datasets/agent-semantics/golden-v0.1.json) and conforms to [agentcert-semantic-golden-dataset.schema.json](../schemas/agentcert-semantic-golden-dataset.schema.json).

## Run the matrix

```bash
npm run semantic-calibration
```

The report is written to `.agentcert/compatibility/semantic-adapter-matrix.json`. Production Acceptance runs the same deterministic calibration and stores its copy beside the signed acceptance report.

The repository also keeps the reviewed [v0.1 matrix snapshot](generated/semantic-adapter-matrix-v0.1.json) so changes to adapter mappings and quality metrics are visible in code review.

## Metrics

- `exactMatchRate`: expected known and unknown cases classified exactly as declared.
- `falseUnknownRate`: expected-known tool contracts that AgentCert left unknown, divided by all expected-known cases.
- `misclassified`: known contracts mapped to the wrong capability.
- `falseKnown`: deliberately unknown controls incorrectly absorbed by a broad alias.

The optional LLM suggestion provider is excluded. Human corrections remain project-scoped data and do not change the built-in golden score.

## What this proves

The pinned tool names and parameter-sensitive cases map deterministically to the expected ontology. In particular, OpenHands `str_replace_editor` is classified from its command argument, so `view` is a read and `create` or `str_replace` is a write.

## What this does not prove

Except for the existing Browser Use evidence, these rows do not execute complete third-party agent workflows. A semantic match does not prove framework runtime compatibility, authorization, gateway enforcement, outcome verification, or business correctness. Those require external smoke runs, controlled adapters, and workflow-specific assurance cases.
