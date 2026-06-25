# Runtime Tool-Risk Checklist for MCP Servers

Use this checklist before exposing tools to production agent systems.

- Identify sources, untrusted sources, sensitive sources, sinks, mutators, and high-blast-radius tools.
- Document scope boundaries in tool descriptions.
- Prefer read-only tools for inspection tasks.
- Separate read and write operations.
- Add explicit confirmation semantics for mutating tools.
- Add result-size limits and structured errors.
- Treat README, webpage, issue, comment, ticket, and email content as untrusted output.
- Test that untrusted output does not trigger privileged calls.
- Test that synthetic sensitive markers do not flow into public or external sinks.
- Emit trace events with tool name, arguments hash, result hash, risk class, and error details.

