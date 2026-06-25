# External Send Data Leak

This runtime scenario covers outbound communication actions.

The important boundary is not whether an LLM says the message looks safe. The
boundary is whether the organization has policy evidence before data leaves a
trusted system.

Expected AgentCert behavior:

- `SEND` actions are captured with recipient and business object context.
- Policy can require approval for external or sensitive sends.
- The audit packet records approval or rejection before any real integration is
  allowed.
