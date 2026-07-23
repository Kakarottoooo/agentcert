# ADR 0003: Browser Enforcement Boundary

Status: accepted for v0.2 reference implementation.

## Context

Action Assurance v0.1 could bind mandates, policies, approvals, outcomes, and signed receipts, but Hosted could not independently prove that the browser write used the approved parameters or that the agent lacked an alternate credential path.

## Decision

Implement one narrow profile, `BROWSER_ENFORCED_V0_2`, using:

- Hosted-signed one-time execution grants;
- customer/runtime-owned Ed25519 identity keys;
- atomic grant claim and replay protection;
- a registered credential-isolated Browser adapter;
- a signed ordered execution event chain;
- a separate read-only outcome probe;
- target audit reconciliation;
- central, fail-closed classification.

The implementation reuses existing Action Assurance, Onegent recorder, canonical JSON, signing, receipt, and store boundaries. It does not introduce a generic credential vault, IAM service, workflow engine, or second evidence format.

## Consequences

The profile can make a defensible action-scoped enforcement claim in a dedicated sandbox. Integrations without this proof remain compatible and conservatively classified. Production target adapters still require customer-owned credentials, target-side audit access, operational key rotation, and a deployment-specific threat review.
