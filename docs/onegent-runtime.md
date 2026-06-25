# Onegent Runtime

Onegent Runtime is the planned production enforcement layer in AgentCert.

Unlike MCPBench and Tripwire CI, it does not ask whether an agent should ship. It asks whether one live action should be allowed right now.

## Planned Responsibilities

- receive proposed actions from an agent or tool gateway;
- classify action risk;
- evaluate policy;
- require human approval when needed;
- execute or deny the action;
- verify the result;
- record an audit event;
- expose evidence back to AgentCert reports.

## Non-Goals For The Current Repository State

- no production action gateway is implemented yet;
- no real credential handling is implemented;
- no irreversible production actions are included in tests.

The first implementation should start with local synthetic actions and deterministic policies, then add integrations only behind explicit adapters.

