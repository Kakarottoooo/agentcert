# ADR 0001: Separate control, enforcement, evidence, and network planes

Status: accepted

## Decision

AgentCert models action assurance as four logical planes while keeping the
current deployable monolith. Plane boundaries are module and protocol
boundaries, not new services.

Existing release assurance feeds action readiness. Existing action and evidence
APIs remain compatible. New immutable objects are added beside current mutable
projections and migrated incrementally.

## Consequences

- We avoid a distributed-system rewrite during Beta.
- Evidence claims distinguish a policy decision from enforcement and an observed result from agent self-report.
- A plane may be extracted later when throughput, isolation, or key custody requires it.
- Until Milestone 2, legacy actions are `OBSERVED_ONLY` or `SELF_REPORTED` unless a verifiable boundary exists.

