# Action Assurance Roadmap

Status at v0.7.0: Milestones 0 and 1 are complete. Milestone 2 is complete for
the narrow `BROWSER_ENFORCED_V0_2` sandbox reference profile and the
Customer-owned Browser Adapter Kit. It does not claim universal browser or
network enforcement. Milestone 3 is partial: offline receipt verification and
signing-key history exist, while relying-party status/disclosure policy remains
future work. Milestones 4-7 remain design-partner driven.

## Milestone 0: architecture baseline

Status: complete.

- Gap map, four-plane architecture, threat model, compatibility plan, and ADRs.

## Milestone 1: first-class mandate and receipt

Status: complete in migrations 023 and the Action Assurance Receipt v0.1 API.

- Hosted immutable mandates and conservative scope validation.
- Action digests, append-only policy decisions, approval binding, and outcome attestations.
- Action Assurance Receipt v0.1 with schema, examples, signing, and verifier test vectors.
- Legacy action/evidence mapping without upgraded trust claims.
- Minimal Hosted action detail exposing enforcement and outcome truth.

## Milestone 2: browser enforcement boundary

Status: complete for the documented sandbox reference profile in migration
024. Production connectors remain outside the shipped trust claim.

- One-time short-lived execution grants with replay prevention.
- Out-of-process browser adapter with isolated credentials.
- Target audit reconciliation and bypass incidents.
- Receipt may become `ENFORCED` only after these proofs pass.

## Milestone 3: independent verification and status

Status: partial.

- Offline CLI/library verifier and trust bundles.
- Public verification endpoint with private evidence separation.
- Key, mandate, build, connector, and receipt status registry.
- Revocation propagation and tamper vectors.

## Milestone 4: identity and delegation

- External identity bindings and workload proof of possession.
- Cross-domain trust bundles and attenuating delegation chains.
- Property-based attenuation tests.

## Milestone 5: relying-party acceptance

- Relying-party identities and trust policies.
- Signed acceptance, conditional acceptance, rejection, and review decisions.

## Milestones 6-7: disputes, metering, and a second adapter

These are design-partner driven. Do not implement insurance logic or multiple
speculative adapters before a real workflow supplies requirements.

