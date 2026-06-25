# OWASP Agentic AI Mapping

Source: OWASP GenAI Security Project resources:

- [Agentic AI - Threats and Mitigations](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)

OWASP's agentic AI guidance focuses on emerging threats in autonomous systems,
including prompt injection, tool misuse, excessive agency, unsafe integrations,
memory/context risks, and weak auditability.

## AgentCert Evidence Coverage

| OWASP-style concern | AgentCert evidence |
|---|---|
| Prompt injection | Tripwire CI `prompt_injection_banner` fault and sensitive-output assertions. |
| Tool misuse | MCPBench tool-call sequence monitoring and tool-risk classification. |
| Excessive agency | Onegent Runtime approval gates for high-risk actions. |
| Unsafe integrations | Local-only runtime demos and explicit non-goals for payment/email/vendor systems. |
| Data exfiltration | MCPBench canaries, taint tracking, and outbound action scenarios. |
| Weak auditability | AgentCert evidence bundle and Onegent audit packet export. |

## Current Gaps

- No complete OWASP Top 10 control-by-control matrix yet.
- No production memory-store scanner yet.
- No identity/authorization adapter yet.

## Direction

The failure scenario library should grow into AgentCert's practical OWASP-style
test corpus: one scenario per concrete agent failure mode, each producing a
portable evidence packet.
