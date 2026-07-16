# Evidence Trust Chain v0.1

Hosted evidence records can carry `agentcert.server_attestation.v0.1`. The
server signs a canonical JSON payload containing the evidence ID, project/run
binding, kind, schema version, SHA-256 digest, byte size, and creation time.

The chain is:

1. The client uploads bytes over an authenticated project route.
2. AgentCert validates file type, quota, manifest reconciliation, and SHA-256.
3. The server canonicalizes the attestation payload by recursively sorting
   object keys and omitting undefined values.
4. The server signs those exact UTF-8 bytes with Ed25519.
5. A verifier fetches `GET /v1/signing-keys/current`, recalculates canonical
   bytes and SHA-256, then verifies the signature.

The TypeScript SDK exports `canonicalJson()` and
`verifyServerAttestation()`. The schemas are:

- `schemas/agentcert-server-attestation.schema.json`
- `schemas/agentcert-evidence-bundle.schema.json`

Configure the hosted service with:

```text
AGENTCERT_EVIDENCE_SIGNING_PRIVATE_KEY=<base64 encoded PKCS#8 Ed25519 PEM>
AGENTCERT_EVIDENCE_SIGNING_KEY_ID=agentcert-prod-2026-01
```

Rotate by deploying a new key ID and retaining old public keys outside the
service for historical verification. v0.1 exposes the current key only; a
durable multi-key transparency endpoint is a follow-up requirement.

A valid signature proves the named server key attested to the stored digest
and metadata. It does not prove the underlying event was truthful, complete,
or caused by the claimed human or agent.
