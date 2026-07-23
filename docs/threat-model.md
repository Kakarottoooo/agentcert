# AgentCert threat model

Status: v0.2, reviewed for Hosted Onboarding v0.2.

## Security objective

AgentCert must preserve who performed an agent action, what was observed, which policy or approval applied, and whether retained evidence still matches its manifest. It is an independent evidence and control layer, not a sandbox for arbitrary untrusted code.

## Trust boundaries

1. Human users authenticate through Supabase and receive organization membership roles.
2. Machine API keys are scoped to exactly one project and explicit read/write scopes.
3. The Control Plane is the only database and object-store access path. Browser clients do not receive database credentials.
4. Uploaded evidence crosses an untrusted-byte boundary and is restricted by MIME/kind, size, quota, manifest digest, retention, and download headers.
5. External agent adapters cross a telemetry boundary. They should submit action/event envelopes and approved artifacts, not prompts, credentials, source trees, or raw customer datasets by default.

## Primary threats and controls

| Threat | Current controls | Residual risk / next control |
| --- | --- | --- |
| Cross-tenant access | Project authorization on every service call; machine key project binding; tenant concurrency tests | Run periodic Postgres/RLS integration tests against staging |
| Project-switch confusion | Stable project IDs and slugs; rename changes display name only; selected project shown beside commands | Require explicit confirmation for destructive project operations before adding them |
| Stolen API key | One-time display, hashed storage, scopes, revocation, last-used timestamp | Expiring keys and service identities are not yet implemented |
| Replay or duplicate writes | Idempotency keys, run external IDs, Redis locks in production | Long-running downstream actions require adapter-specific idempotency contracts |
| Agent bypasses approved browser action | One-time signed grant, runtime key proof, credential-isolated adapter, target-audit reconciliation | Coverage is limited to the dedicated sandbox credential and declared reconciliation window |
| Runtime or adapter impersonation | Tenant-bound Ed25519 runtime identity, adapter ID/version/origin binding, short grant TTL | Production key custody and rotation remain deployment responsibilities |
| Event omission or mutation | Strict sequence, previous-event hash, per-event runtime signature, required event set, checkpoint | Runtime host compromise is not hardware-attested in the reference profile |
| Malicious evidence | MIME/kind allowlist, quotas, manifest SHA-256 reconciliation, no execution, CSP/nosniff | Archive inspection and malware scanning remain required before enterprise uploads |
| Evidence tampering | Canonical JSON, server Ed25519 signing, historical public keys, deletion ledger | Hardware-backed signing keys are not yet configured |
| Prompt/PII leakage | Templates submit bounded metadata; pilot context allowlist; docs prohibit secrets | Automated PII detection/redaction needs broader corpus testing |
| Hosted outage/data loss | Production smoke, incident state machine, PostgreSQL restore drill workflow | A real restore drill needs a separate protected restore database and measured RTO/RPO |
| Feedback abuse | Authenticated project membership, bounded enums/text/context | Per-project moderation/export policy is still basic |
| Supply-chain compromise | Pinned major GitHub Actions, npm package smoke from tarball, no runtime template dependency | Release provenance and dependency review should become release requirements |

## What AgentCert does not prove

- It does not prove an agent is safe for every task or environment.
- It does not prove an uploaded trace is complete unless the adapter boundary, manifest, and expected artifacts are independently controlled.
- It does not replace identity providers, endpoint security, transaction authorization, or legal compliance review.
- A passing historical run is evidence about that version and scenario, not a permanent certification.

## Stronger-model test

More capable agents increase the number and impact of delegated actions. AgentCert therefore concentrates on durable controls that models cannot self-attest: identity, least privilege, runtime gates, observed-outcome verification, incident history, and third-party evidence integrity.

## MCPBench evaluator boundary

MCPBench uses benign synthetic conditions to test sensitive canary flow into public sinks, untrusted tool output before privileged calls, retry loops, unsafe recovery, and ambiguous tool schemas. Markers such as `BENIGN_EVAL_MARKER_UNTRUSTED_CONTENT` and `BENIGN_EVAL_MARKER_FAKE_SECRET_CANARY` are defensive fixtures, not real secrets.

MCPBench does not run real exploit payloads, steal credentials, compromise production systems, or claim complete security certification. Live-provider jailbreak testing remains outside its default boundary.
