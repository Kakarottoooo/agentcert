# Assurance Case and Certification Lifecycle v0.1

AgentCert calls this an **assurance case**, not an official certification. A case is a narrow claim about one declared agent version, one policy pack, one locked evaluation plan, and a specific set of evidence.

## Lifecycle

`draft -> evaluating -> review_required -> issued`

An issued case can become `suspended`, `revoked`, or `expired`. Suspended and expired cases return to `evaluating` before another review. Revocation is terminal in v0.1.

Reading an elapsed issued case or its public verification record performs a concurrency-safe system transition to `expired` and appends the expiry decision. A stale report cannot remain publicly represented as issued merely because an operator did not click a button.

Every transition appends an immutable decision with actor, reason, evidence IDs, and timestamp. Updates use optimistic state checks so two reviewers cannot commit the same transition. The creator cannot issue the report; a separate owner, admin, or reviewer must make the issuance decision.

Issuance requires:

- every evidence kind named by the locked plan;
- evidence owned by the same project;
- a configured server Ed25519 signing key;
- a separate human reviewer;
- explicit limitations and an expiry no more than 365 days away.

Public verification is opt-in. Private cases have no public identifier. A public record contains the signed report and sanitized lifecycle history, not actor emails or private artifact bytes.

## What it proves

- the evaluation plan did not change after case creation;
- the listed evidence bytes are identified by SHA-256 and project ownership;
- a separate authorized reviewer made the recorded decision;
- the report bytes were signed by the named AgentCert server key;
- suspension, expiry, or revocation remains observable.

## What it does not prove

- regulatory approval or legal compliance;
- future behavior outside the declared version, environment, controls, or evidence;
- correctness of evidence produced by an untrusted adapter without independent validation;
- that all relevant risks were included in the evaluation plan.
