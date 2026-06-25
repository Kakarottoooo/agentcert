# AgentCert Lifecycle

AgentCert is one product with multiple enforcement points.

## Before Release

Pre-release gates run in local development, CI, and staging. Their job is to fail fast before an agent reaches users or production systems.

### MCPBench

MCPBench evaluates MCP servers and agent-exposed tools:

- tool inventory and risk classification;
- runtime tool-call sequence monitoring;
- sensitive synthetic canary flow;
- untrusted output to privileged tool chains;
- retry loops and failure recovery;
- reproducible JSONL traces, markdown reports, JSON reports, and badges.

It answers:

> Are these tools safe, observable, reliable, and production-ready enough to expose to agents?

### Tripwire CI

Tripwire CI evaluates browser and computer-use agents:

- controlled Chromium launch;
- CDP endpoint handoff to an agent command;
- modal overlays, network slowness, HTTP failures, button text drift, prompt injection banners;
- screenshots, DOM snapshots, trace artifacts;
- deterministic assertions and CI pass/fail gates.

It answers:

> Should this agent be released?

## After Release

Production enforcement happens when a real action is about to affect a real system.

### Onegent Runtime

Onegent Runtime is the planned production action boundary:

- risk scoring for the current action;
- policy checks;
- human approval for high-risk actions;
- result verification;
- audit logging;
- rollback or escalation hooks.

It answers:

> Should this specific action be allowed right now?

## Shared Evidence Model

All layers should eventually emit compatible AgentCert evidence:

- run metadata;
- scenario or task identity;
- trace artifact paths;
- policy violations;
- assertion results;
- scores;
- pass/fail decision;
- reproduction command;
- suggested fixes.

This keeps the product cohesive while allowing each runtime engine to stay technically appropriate for its domain.

