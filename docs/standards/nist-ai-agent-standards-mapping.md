# NIST AI Agent Standards Initiative Mapping

Source: [NIST AI Agent Standards Initiative](https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative)
and NIST's [February 2026 launch announcement](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure).

NIST frames the initiative around trusted, interoperable, and secure agentic AI
adoption. AgentCert maps to this direction by producing portable evidence about
agent behavior before release and at runtime.

## AgentCert Evidence Coverage

| NIST direction | AgentCert evidence |
|---|---|
| Secure agent behavior | MCPBench policy violations, tool-call traces, taint tracking, and risk classification. |
| Interoperable assurance | JSON schemas for result, evidence item, and evidence bundle artifacts. |
| Runtime accountability | Onegent Runtime approval, mock execution, verification, and audit packet records. |
| Testing and benchmark readiness | Deterministic MCPBench suites, Tripwire CI fault injection, failure scenario library. |
| Cross-framework posture | Framework-neutral CLI and schemas that can ingest multiple product artifacts. |

## Current Gaps

- No alignment with a final NIST control catalog because the initiative is still
  developing.
- No agent identity or signing layer yet.
- No formal integration with ISO/IEC or government procurement workflows.

## Direction

AgentCert should focus on evidence portability and repeatability so it can track
future NIST agent standards without tying the project to one vendor framework.
