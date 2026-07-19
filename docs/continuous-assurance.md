# Continuous Assurance Contract v0.1

A signed assurance report is a historical statement. The continuous assurance
contract is the current validity state attached to that report. AgentCert never
rewrites the signed report after issuance.

## Declared scope

`agentcert.assurance_scope.v0.1` identifies the exact:

- agent ID, version, and optional artifact SHA-256;
- model provider, name, and pinned version;
- prompt SHA-256;
- tool-manifest SHA-256;
- policy ID, version, and optional SHA-256; and
- scenario-suite ID, version, and SHA-256.

AgentCert normalizes this object, serializes it as canonical JSON, and stores one
SHA-256 fingerprint. Component fingerprints identify whether agent, model,
prompt, tools, policy, or scenario suite changed without treating every change
as an opaque mismatch.

Validate the file before using it in CI:

```bash
npx agentcert schema validate \
  --schema assurance-scope \
  --file agentcert.assurance-scope.json
```

## Freshness states

| State | Meaning |
| --- | --- |
| `CURRENT` | The deployed scope still matches the independently reviewed baseline and the latest authoritative evaluation passed. |
| `REVALIDATION_REQUIRED` | A release/nightly run changed scope or did not pass. A passing run does not silently restore independent review. |
| `SUSPENDED` | An authorized human suspended or revoked the underlying case. |
| `EXPIRED` | The report reached its declared expiry. |

`Start revalidation` creates a successor draft using the last observed scope.
The old case, report, decision ledger, and attestation remain immutable.

## One-click adoption from a 7-Day Review

An issued, signed, `CURRENT` 7-Day Review exposes **Generate continuous CI
kit** in the Hosted workspace. The deterministic kit contains exactly:

- `agentcert.assurance-scope.json`, the canonical reviewed scope;
- `.github/workflows/agentcert-continuous-assurance.yml`, the three-layer CI
  workflow; and
- `AGENTCERT-CONTINUOUS-ASSURANCE.md`, installation and invalidation notes.

The kit contains only project and assurance-case identifiers. It references
`AGENTCERT_API_KEY` as a GitHub Actions secret and never includes the secret.
Generating the kit is idempotent and records the workflow SHA-256 in the
contract history.

After a successor revalidation is independently issued, generate the kit again
from that successor. The replacement workflow binds future runs to the new
case while preserving the original report and lineage.

## Trigger policy

- **Pull request:** quick, prospective. Drift is shown as “would require
  revalidation” but does not change production status.
- **Release:** authoritative. Run failure or scope drift changes the contract to
  `REVALIDATION_REQUIRED`.
- **Nightly:** authoritative regression run for the current release. It should
  include the stable suite plus newly added and high-risk scenarios.

The Tripwire Action accepts optional `pull-request-config`, `release-config`,
and `nightly-config` inputs. All three fall back to the existing `config`, so
teams can adopt layered suites without breaking the initial integration.

One run is counted once even if completion is retried or arrives concurrently.
Assurance-case updates use optimistic concurrency checks so two runs cannot
silently overwrite usage metrics.

An authoritative passing run updates metrics and confirms scope, but does not
silently restore a contract already marked `REVALIDATION_REQUIRED`. Only an
independently issued successor case establishes a new `CURRENT` baseline.

## Hosted CLI binding

```bash
npx agentcert run --config agentcert.config.json --push \
  --assurance-case "$AGENTCERT_ASSURANCE_CASE_ID" \
  --assurance-scope agentcert.assurance-scope.json \
  --assurance-trigger auto
```

`auto` maps GitHub pull requests to `pull_request`, schedules to `nightly`, and
push/release/manual workflows to `release`. The Hosted workspace shows current
status, cause, changed components, expiry, history, trigger counts, and
completed revalidation-cycle duration. It sends threshold-tracked 30-day,
7-day, and 1-day expiry warnings through the existing durable email and
signed-webhook queues. Delivery is at least once: consumers should deduplicate
signed webhook events by event ID. Verified recipients can subscribe to status changes, and signed
webhooks emit:

- `assurance.current`
- `assurance.revalidation_required`
- `assurance.suspended`
- `assurance.expired`
- `assurance.expiry_warning`

History is bounded to the latest 500 state events, with the number of compacted
older events retained. A revalidation successor inherits the history and
records start, completion, and elapsed time without rewriting the signed source
report.

## Adoption metrics

The administrative pilot funnel ends at **First CURRENT**, not first upload.
"Install" is defined as the first authenticated CLI use of a project API key.
AgentCert measures install-to-first-CURRENT and project-to-first-CURRENT from
operational records already stored by the control plane; it does not create a
separate analytics identity or event stream.

The independent public
[continuous assurance canary](https://github.com/Kakarottoooo/agentcert-continuous-assurance-canary)
has two isolated jobs. The distribution job uses only the public npm package
and `Kakarottoooo/agentcert/actions/tripwire@v0`. The Hosted E2E job uses the
unaltered kit generated by a dedicated canary assurance case, a dedicated
Hosted project, and a project-scoped key limited to `runs:read`, `runs:write`,
`events:write`, and `evidence:write`.

On release and nightly runs, the generated workflow fails unless the bound run
is authoritative `CURRENT` and its evidence manifest is complete. It uploads a
redacted `agentcert.generated_kit_health.v0.1` artifact with status, evidence
counts, diagnostics codes, and install-to-first-CURRENT duration. Project,
case, run, scope-fingerprint, and credential values are deliberately omitted.
The public workflow badge is the health surface; customer evidence and tenant
identifiers remain private.

## What continuity proves

- the baseline scope and its fingerprint were present in the signed report;
- subsequent bound runs declared a canonical scope and trigger;
- current invalidation state and reasons are durable and visible; and
- independent review is required to establish a new CURRENT baseline.

It does not prove that an uninstrumented deployment used the declared scope, or
that every production action passed through AgentCert. Stronger claims require
the enforced gateway, trusted recorder, source signatures, and independent
outcome probes.
