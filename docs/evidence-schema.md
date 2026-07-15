# AgentCert Evidence Schema v0.1

AgentCert evidence is a portable JSON packet for browser-agent CI, MCP/tool
checks, and runtime action-gating audits. The current stable bundle version is:

```json
{
  "schemaName": "agentcert.evidence_bundle",
  "schemaVersion": "agentcert.evidence.v0.1",
  "schemaSemver": "0.1.0",
  "kind": "agentcert.evidence_bundle"
}
```

## What This Proves

An evidence bundle proves that a named subject was evaluated by one or more
AgentCert engines, at a recorded time, with recorded verdicts, findings, and
artifact pointers.

For Tripwire CI, this means the bundle can point to deterministic browser-agent
fault runs, screenshots, DOM snapshots, traces, JUnit, an HTML report, and a
badge.

For Onegent Runtime, this means the bundle can point to local action intent,
risk, policy, approval, verification, and audit artifacts.

## What This Does Not Prove

AgentCert evidence is not a security guarantee, official certification, NIST
compliance claim, AIUC-1 certification, or proof that a production integration
cannot fail.

It also does not prove that the artifact producer was honest. Ed25519
signatures prove file integrity and possession of a signing key, but an
independent reviewer must decide who controls and trusts that key.

## Required Bundle Fields

- `schemaName`: must be `agentcert.evidence_bundle`.
- `schemaVersion`: must be `agentcert.evidence.v0.1`.
- `schemaSemver`: must be `0.1.0`.
- `kind`: must be `agentcert.evidence_bundle`.
- `runId`: AgentCert bundle run id.
- `generatedAt`: ISO timestamp.
- `subject`: reviewed agent, MCP server, tool, application, or unknown target.
- `verdict`: overall pass/fail, score, and level.
- `summary`: covered products and finding counts.
- `results`: normalized product results.
- `evidence`: flattened findings.
- `artifacts`: named paths for reports, traces, screenshots, DOM, or audit files.
- `standards`: mapping notes and non-certification language.

`artifactManifest` is an optional v0.1 extension for byte-level hosted
reconciliation. New `agentcert push` uploads add it automatically:

```json
{
  "artifactManifest": {
    "schemaVersion": "agentcert.artifact_manifest.v0.1",
    "entries": [
      {
        "path": "screenshots/step-1.png",
        "sha256": "64 lowercase hexadecimal characters",
        "sizeBytes": 42831,
        "kind": "screenshot"
      }
    ]
  }
}
```

The field stays optional so existing `agentcert.evidence.v0.1` files remain
readable. A hosted run without it is explicitly `partial` and `legacy`; it is
never presented as byte-reconciled evidence.

Optional metadata may appear inside evidence findings and product-specific
artifacts. Consumers should ignore unknown optional fields and fail closed when
required top-level fields or required enum values are missing.

## Validate

```bash
npx agentcert validate .agentcert/latest/agentcert-evidence.json
npx agentcert validate .agentcert/latest/agentcert-evidence.json --check-artifacts
npx agentcert validate examples/agentcert/evidence-bundle.example.json
```

`--check-artifacts` verifies that artifact paths referenced by the evidence
bundle exist from the current repository root. Use `--artifact-root <path>` when
the bundle should be checked from a different root directory.

The explicit command is also available:

```bash
npx agentcert schema validate --schema evidence-bundle --file .agentcert/latest/agentcert-evidence.json
```

## Schema Files

- `schemas/agentcert-evidence-bundle.schema.json`
- `schemas/agentcert-result.schema.json`
- `schemas/agentcert-evidence.schema.json`
- `schemas/agentcert-corpus-record.schema.json`
- `schemas/agentcert-failure-review.schema.json`
- `schemas/agentcert-failure-classifier-evaluation.schema.json`
- `schemas/agentcert-monitor-snapshot.schema.json`
- `schemas/agentcert-release-gate.schema.json`
- `schemas/agentcert-evidence-signature.schema.json`

The longer standards and taxonomy discussion lives in
`docs/standards/evidence-schema.md`.

## Integrity And Provenance

The release gate records SHA-256 digests for local source artifacts and the
generated evidence bundle. Generate a local Ed25519 key pair and create a
detached signature when the evidence must cross a trust boundary:

```bash
npx agentcert evidence keygen --private-key .agentcert/keys/evidence-private.pem --public-key .agentcert/keys/evidence-public.pem
npx agentcert evidence sign .agentcert/latest/agentcert-evidence.json --private-key .agentcert/keys/evidence-private.pem
npx agentcert evidence verify .agentcert/latest/agentcert-evidence.json --signature .agentcert/latest/agentcert-evidence.json.sig.json --public-key .agentcert/keys/evidence-public.pem
```

Never commit the private key. Store it in a CI secret manager or offline
signing environment. The signature contract is
`agentcert.evidence_signature.v0.1`.
