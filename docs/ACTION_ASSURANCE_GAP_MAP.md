# Action Assurance Gap Map

Status: historical Milestone 0 baseline for
`agentcert.action_assurance_receipt.v0.1`, updated with v0.7.0 resolution notes.
Milestone 1 shipped in migration 023. The narrow browser reference profile in
Milestone 2 shipped in migration 024 and is documented in
[`browser-enforcement-boundary.md`](browser-enforcement-boundary.md). Remaining
gaps apply outside that exact profile.

## Product boundary

AgentCert is evolving from a collection of release and runtime assurance tools
into an independent assurance layer for consequential agent actions. Existing
release testing remains an input to action readiness; it is not replaced.

The first slice proves a narrower statement:

> A declared action was evaluated against an immutable mandate, produced an
> append-only policy and outcome record, and was summarized in a signed,
> independently parseable receipt with explicit limitations.

The base receipt does not prove that every target-system path was technically
unbypassable. The v0.7 browser profile can raise one action to `ENFORCED` only
after a one-time execution grant, registered runtime, credential-isolated
adapter, complete signed event chain, independent outcome probe, and target
audit reconciliation all pass. It still cannot prove that credentials or
paths outside the registered gateway do not exist.

## Reuse and gaps

| Area | Existing capability | Gap | Milestone 1 decision |
| --- | --- | --- | --- |
| Action intent | Hosted `agentcert_actions` and Onegent `ActionIntent` | Parameters, build identity, nonce, deadline, and data classification are incomplete | Extend the public action record compatibly; preserve `/actions` |
| Mandate | Signed Onegent `agentcert.action_mandate.v0.1` and file store | Hosted persistence, status, use limits, delegation, and richer constraints | Add immutable hosted mandate records and conservative scope checks |
| Identity | Supabase users, API keys, agent principals, collector identities | No shared assurance-level model or cross-domain identity binding | Define identity references in the protocol; defer full identity registry |
| Agent build | Continuous-assurance scope fingerprint | Build is not a first-class action principal | Add build reference fields and map legacy fingerprints; registry follows |
| Policy | Risk assessment and action decision | Decision is mutable on the action row and not separately signed | Append a first-class policy decision record |
| Approval | Human approval record | Not bound to immutable action bytes | Add `action_digest_sha256`; old approvals remain readable with a warning |
| Enforcement | Registered controlled adapter and declared credential isolation | Paths outside the registered gateway remain unobservable | Milestone 2 now adds one-time grants and central classification for `BROWSER_ENFORCED_V0_2` only |
| Recorder | Durable, source-signed, hash-linked action journal | Hosted action events and Onegent journal are separate concepts | Reference the trusted run receipt when available; retain legacy event APIs |
| Outcome | Onegent independent probe and Hosted observed state | Hosted callers can self-assert an observation method | Persist observation method and provenance; self-report is always lowest trust |
| Receipt | Trusted run receipt, audit packet, evidence bundle, server attestation | No action-level portable statement joining mandate, policy, execution, and outcome | Add Action Assurance Receipt core plus detached server attestation |
| Verification | Evidence signature checks and signing-key history | No action receipt verifier or status lifecycle | Add schema and local structural/cryptographic verifier in this slice; status follows |
| Revocation | Signing-key lifecycle and continuous-assurance freshness | No common status event or propagation | Add an audited mandate-revocation transition now; implement cross-receipt status propagation in Milestone 3 |
| Relying party | Public evidence view | No external trust policy or signed acceptance | Explicitly deferred to Milestone 5 |

## Compatibility

- `npx agentcert init`, `run`, GitHub Action, reports, badges, and evidence
  bundles remain unchanged.
- Existing `POST /v1/projects/:projectId/actions` remains valid without a
  mandate and is marked as a legacy/unmandated path in any receipt.
- Existing `assuranceContext` is retained. A mandate-backed action additionally
  stores an immutable action digest.
- Existing evidence bundles can be referenced from a receipt, but are not
  silently reclassified as enforced action evidence.
- Existing Onegent types and API aliases remain exported.

## Interfaces retained but scheduled for deprecation

- Direct `verifyAction(observedState)` remains available for compatibility. Its
  result is `AGENT_SELF_REPORT` unless independently signed provenance is
  supplied and validated.
- `assuranceContext.evidenceStrength = enforced` remains readable, but a new
  receipt does not convert that declaration into `ENFORCED` without an
  enforcement proof.
- Mutable decision/status columns on `agentcert_actions` remain operational
  projections. Append-only decision and outcome rows are the audit source.

## Security and migration risks

- Existing callers may assume an approved action was executed through AgentCert.
  Receipts must separate approval from enforcement.
- A migration must not rewrite historical actions or synthesize missing
  authority, signatures, or outcome provenance.
- PostgreSQL mandate use counters and browser execution grants are consumed
  through atomic conditional updates. Concurrent claims admit exactly one
  winner. This is a complete boundary only for the registered adapter and
  declared target path; credentials outside that path remain a documented
  bypass risk.
- Canonical JSON is currently deterministic within AgentCert, but is not yet a
  claimed RFC 8785 implementation. Cross-language vectors are required before
  making that claim.
- Public verification must never return redacted parameters, private evidence,
  credentials, or tenant-internal identifiers without an explicit disclosure
  policy.

## Customer input still required

- Which action class and target system should become the first production-like
  non-browser adapter.
- Which identity provider and workload identity are present in a design
  partner's deployment.
- Which target audit log can be reconciled to detect bypass.
- Which receipt fields a real relying party requires before acceptance.
- Retention, disclosure, and dispute procedures for customer evidence.
