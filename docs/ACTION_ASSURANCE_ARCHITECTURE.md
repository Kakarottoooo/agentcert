# Action Assurance Architecture

## Four planes

### Control plane

Owns identities and build references, immutable mandates, policy decisions,
approvals, revocation state, and relying-party trust policy. It decides whether
an action may proceed but does not itself prove execution.

### Enforcement plane

Owns one-time execution grants, credential custody, controlled adapters,
network boundaries, and bypass detection. `ENFORCED` is valid only when this
plane produces verifiable proof that the agent lacked an alternate write path.

### Evidence plane

Owns the source-signed event journal, independent outcome probes, evidence
manifests, receipt issuance, signing-key lifecycle, and verification. Facts are
classified as directly observed, externally asserted, inferred, or self
reported.

### Network plane

Owns public/offline verification, relying-party decisions, incidents,
disputes, recovery, and privacy-preserving usage metering. It never treats an
AgentCert signature as proof that a relying party trusts the underlying
principal.

## Action flow

```text
ActionIntent
  -> identity/build binding
  -> mandate validation
  -> policy decision
  -> approval when required
  -> one-time execution grant (Milestone 2)
  -> controlled adapter execution
  -> source-signed event journal
  -> independent outcome probe
  -> Action Assurance Receipt
  -> verifier and relying-party policy
```

## Source of truth

- Immutable objects: mandate payload, action digest, policy decision, approval
  binding, outcome attestation, receipt core, signatures.
- Append-only state: action events, status/revocation events, disputes,
  relying-party decisions.
- Mutable projections: action status, current receipt status, dashboard counts,
  next action. Projections can be rebuilt and are not evidence.

## Receipt boundary

The receipt core is protocol data and does not expose database rows. A detached
signature envelope attests to canonical receipt bytes. A receipt states:

- who and what build requested the action;
- which mandate and policy decision applied;
- whether approval was bound to the same action digest;
- what enforcement mechanism was actually evidenced;
- which event chain and outcome observation support the result;
- what AgentCert controlled and did not control;
- validity, status, warnings, and evidence references.

## Compatibility boundary

The Hosted API continues to accept legacy actions. New mandate-backed actions
use the same route with additional fields. Receipt issuance is a separate,
idempotent operation so existing clients do not unexpectedly create public
claims.

