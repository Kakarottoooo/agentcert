# Action Assurance Protocol v0.1

AgentCert records what a high-risk agent action was authorized to do, whether execution passed through a controlled boundary, and whether an independent read path observed the intended outcome.

## Protocol

1. An issuer signs an immutable `agentcert.action_mandate.v0.1` document.
2. A source collector signs `RUN_STARTED` before accepting action events.
3. Every event receives a strictly increasing sequence, payload digest, previous-event hash, event hash, and Ed25519 source signature.
4. A high-risk action must bind to an active mandate before policy or approval.
5. Execution requires a capability registered by `createControlledActionAdapter()` whose credentials are unavailable to the agent process.
6. A separate read-only capability registered by `createIndependentOutcomeProbe()` observes system state after execution.
7. The collector signs `RUN_COMPLETED` and a receipt that reconciles the journal, dropped events, mandate digest, action IDs, and evidence strength.
8. The hosted service may add a separate server attestation. It does not replace the customer-side source signature.

## Evidence strength

| Level | Minimum claim |
| --- | --- |
| `reported` | A producer supplied a result, without a reconciled source record. |
| `recorded` | A source-signed, hash-linked run was reconciled without undeclared gaps. |
| `enforced` | The action also used a verified mandate and credential-isolated execution adapter. |
| `outcome_verified` | A separate outcome probe observed and matched the expected state. |
| `independently_reviewed` | An identified reviewer issued a scoped assurance case over the underlying evidence. |

Levels are ordered claims, not scores. A passing test at `reported` is not equivalent to a passing action at `outcome_verified`.

## Failure and recovery semantics

- Journal appends are persisted and `fsync`ed before they are returned.
- Sink delivery is at least once. An acknowledgement advances only after the sink accepts a record.
- A malformed final JSONL fragment is removed on restart and recorded as `JOURNAL_RECOVERED`.
- Known drops create an explicit sequence gap and `EVENTS_DROPPED` record. Undeclared gaps, duplicates, broken hashes, or invalid signatures make the journal invalid.
- Reusing a mandate ID with different bytes is rejected by the append-only mandate store.

## Trust boundaries and non-claims

The v0.1 SDK rejects plain structural adapter objects and accepts only capabilities created by `createControlledActionAdapter()`, but process isolation and credential custody must still be enforced by the deployment architecture. If the agent can call the target system directly, it can bypass the SDK. The strongest deployment creates the adapter outside the agent process, keeps write credentials only in the AgentCert-controlled gateway, and gives the outcome probe separate read credentials.

Hash linking detects later mutation and omission inside a collected journal; it cannot prove that an uninstrumented action never happened. Source keys must be protected and rotated outside the agent process. AgentCert does not claim that a verified run guarantees future behavior or regulatory compliance.
