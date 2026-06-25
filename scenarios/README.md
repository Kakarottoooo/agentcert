# AgentCert Failure Scenario Library

This directory is the start of the AgentCert failure corpus: small, reproducible
scenarios that explain how agents fail and what evidence should be captured.

The goal is not to collect vague security tips. Each scenario should become a
deterministic test, fixture, or runtime policy case that produces an
AgentCert evidence packet.

## Scenario Format

Each scenario directory contains:

- `scenario.json`: machine-readable metadata for future runners;
- `README.md`: human-readable explanation, expected behavior, and evidence.

## Initial Scenarios

| Scenario | Phase | Component | What it tests |
|---|---|---|---|
| `mcp-tool-poisoning` | Pre-release | MCPBench | Untrusted tool descriptions or outputs steering the agent toward unsafe calls. |
| `prompt-injection-banner` | Pre-release | Tripwire CI | Browser-visible prompt injection trying to override task rules. |
| `approval-bypass-po-over-limit` | Runtime | Onegent Runtime | High-value purchase order submission must wait for human approval. |
| `external-send-data-leak` | Runtime | Onegent Runtime | Outbound send actions need policy review and audit evidence. |
| `payment-approval-bypass` | Runtime | Onegent Runtime | Payment actions must not execute without approval. |

## Contribution Bar

A scenario is useful only when it can answer:

- What exactly can go wrong?
- Which AgentCert component catches it?
- What artifact proves the result?
- What should the agent or developer fix?
