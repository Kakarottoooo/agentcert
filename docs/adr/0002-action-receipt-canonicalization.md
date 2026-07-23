# ADR 0002: Separate receipt core from signature envelope

Status: accepted for v0.1

## Decision

The Action Assurance Receipt has a versioned JSON core and detached Ed25519
attestations. AgentCert's existing recursively sorted canonical JSON is retained
for backward compatibility in v0.1. Golden byte vectors are required.

The core does not use database column names and can later be wrapped in JWS,
COSE, DSSE, or W3C VC without changing its semantics. AgentCert does not claim
external envelope conformance until dedicated tests exist.

## Consequences

- Existing signing infrastructure and historical keys remain usable.
- Offline verification does not require the Hosted UI.
- Cross-language implementations must match checked-in canonical byte vectors.

