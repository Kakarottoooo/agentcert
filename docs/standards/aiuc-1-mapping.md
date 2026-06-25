# AIUC-1 Mapping

Source: [AIUC](https://aiuc.com/) and [AIUC-1](https://aiuc-1.com/).

AIUC describes AIUC-1 as a standard for AI agents covering data and privacy,
security, safety, reliability, accountability, and societal risk. AgentCert does
not certify AIUC-1 compliance. It can produce technical evidence that helps a
team prepare for AIUC-1-style review.

## AgentCert Evidence Coverage

| AIUC-1 concern | AgentCert evidence |
|---|---|
| Data and privacy | MCPBench taint tracking, canary leakage checks, Tripwire sensitive-text assertions. |
| Security | MCP/tool poisoning scenarios, prompt-injection browser tests, runtime policy gates. |
| Safety | Runtime approval requirements for high-risk `SUBMIT`, `PAY`, `SEND`, and `UPDATE` actions. |
| Reliability | Deterministic CI gates, repeatable scenarios, pass/fail reports, trace artifacts. |
| Accountability | Onegent Runtime audit packets with action, approval, execution, verification, and event timeline. |
| Reviewability | `agentcert-evidence.json` and `agentcert-report.md` as portable evidence artifacts. |

## Current Gaps

- No official AIUC relationship or certification authority.
- No legal, organizational, or HR control review.
- No production identity-provider integration yet.
- No cryptographic signing of evidence packets yet.

## Direction

AgentCert should keep mapping evidence to AIUC-1 concerns while avoiding claims
of official certification. The target phrase is:

> AgentCert helps generate reviewable evidence for AIUC-1-style agent assurance.
