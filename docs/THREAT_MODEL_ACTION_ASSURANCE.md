# Threat Model: Action Assurance

## Protected claims

AgentCert protects the integrity and provenance of authority, policy,
execution, outcome, and receipt claims for a bounded action. It does not claim
that the model is generally safe or that no external write path exists unless
the enforcement boundary proves that fact.

## Trust boundaries

- Human and organization identity provider.
- Agent process and agent build artifact.
- AgentCert control plane and tenant boundary.
- Customer-owned collector and signing key.
- Enforcement gateway, adapter, and credential store.
- Target system and independent read path.
- AgentCert issuer key and public verifier.
- External relying party and its trust policy.

## Threats and required controls

| Threat | Required control |
| --- | --- |
| Agent or build impersonation | Identity/build digest binding and proof of possession |
| Mandate forgery or mutation | Canonical digest, issuer signature, status and validity checks |
| Delegation privilege escalation | Child-scope subset validation and revocation propagation |
| Confused deputy | Explicit audience, resource, operation, principal, and action digest |
| Replay and TOCTOU | Nonce, short TTL, one-time grant, transactional use, recheck at execution |
| Credential theft or log leakage | Credential broker, redaction, no secret in evidence |
| Prompt/tool-output injection | Policy boundary independent of model text; controlled adapter constraints |
| Bypass execution | Credential/network exclusivity plus target audit reconciliation |
| Adapter or collector tampering | Workload identity, source signature, heartbeat, hash-linked events |
| Issuer-key compromise | Key ID, rotation, status, revocation, historical verification |
| Event deletion/reorder/duplicate | Strict sequence, previous hash, signature, dropped-event declaration |
| Outcome manipulation | Independent read credentials and multiple observation methods |
| Cross-tenant exposure | Project-scoped authorization, RLS, tenant isolation tests |
| Relying-party impersonation | Bound identity and signed acceptance decision |
| Revocation delay and clock skew | Signed effective time, bounded skew, online status policy |
| Break-glass or malicious admin | Extra approval, bounded scope, append-only admin audit |
| Retention/deletion conflict | Legal hold, deletion journal, receipt limitation after evidence expiry |

## Milestone 1 residual risks

- No one-time execution grant or transactionally consumed mandate use count.
- Hosted outcome input is not independently trustworthy without a validated source signature.
- Existing in-process controlled adapter registration cannot prove that no alternate credential path exists.
- Canonical JSON is deterministic but not a claimed external standard profile.
- Status and revocation are represented but full propagation is deferred.

