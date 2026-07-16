# Evidence Conformance Suite v0.1

The conformance suite lets an independent implementation prove that it emits a
compatible AgentCert evidence bundle. It checks four deterministic boundaries:

1. Required AgentCert evidence v0.1 identity and semantic fields.
2. Compatibility with the published v0.1 top-level field set.
3. A normalized, unique artifact manifest with path, SHA-256, size, and kind.
4. Exact agreement between every manifest declaration and the artifact bytes.

Run the checked-in passing fixture:

```bash
npx agentcert conformance examples/conformance/evidence.valid.json \
  --artifact-root examples/conformance/artifacts \
  --implementation my-agent-adapter \
  --out .agentcert/latest/conformance.json
```

The command exits non-zero if any check fails. The report conforms to
`schemas/agentcert-conformance-report.schema.json`.

## What This Proves

- The bundle uses the supported AgentCert evidence v0.1 identifiers.
- Required semantic fields are present.
- Manifest paths are safe, normalized, and unique.
- Declared artifact hashes and sizes match the bytes supplied to the verifier.

## What This Does Not Prove

- That the agent is safe, reliable, compliant, or suitable for production.
- That evidence was collected independently or without tampering before it was
  hashed.
- That a verdict or standards mapping is substantively correct.
- That undeclared external systems behaved as claimed.

Conformance is format and byte-integrity compatibility. Server signing,
trusted collection, policy review, and certification are separate assurance
claims.
