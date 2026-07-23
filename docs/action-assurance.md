# Action Assurance Protocol v0.1

AgentCert Action Assurance produces a portable, signed receipt for one consequential
agent action. It is intentionally narrower than a general trace: the receipt binds
the action intent, mandate, policy decision, approvals, execution-boundary evidence,
observed outcome, and referenced artifacts.

## Evidence strength

The receipt reports one explicit strength level:

- REPORTED: facts were supplied by the caller and signed by AgentCert as received.
- RECORDED: a verified event-chain digest is present.
- ENFORCED: a verified execution grant and enforcement boundary are present.
- OUTCOME_VERIFIED: a signed, non-agent outcome source attests to observed state.
- INDEPENDENTLY_REVIEWED: reserved for a separately identified reviewer decision.

Evidence strength is not a quality score. The enforcement level, facts, controls,
and warnings remain separate so a verified outcome cannot imply that alternate
execution paths were blocked.

## Hosted API flow

1. Create an immutable, short-lived mandate with POST /v1/projects/:projectId/mandates.
2. Propose an action with mandateId and requireMandate set to true.
3. Approve or reject the action. The approval is bound to the canonical action digest.
4. Execute only through a controlled adapter when an ENFORCED claim is required.
5. Submit observed state and its observation method.
6. Issue a signed receipt with POST /v1/projects/:projectId/actions/:actionId/receipt.
7. Retrieve receipts with GET /v1/projects/:projectId/receipts.

The public SDK exposes createMandate, assessAction, issueActionReceipt,
listActionReceipts, and getActionReceipt.

## What AgentCert controls

- Canonical action-intent binding.
- Mandate scope and validity checks.
- Atomic mandate use limits.
- Append-only policy decisions and action-bound approvals.
- Receipt canonicalization and AgentCert server attestation.
- Explicit classification of controlled and uncontrolled boundaries.

## What AgentCert does not automatically control

- Credentials held outside an AgentCert gateway.
- Alternate network or execution paths.
- A caller falsely labeling self-reported state as a target-system observation.
- Physical-world outcomes not covered by an independent probe.
- Customer identity claims without a stronger identity attestation.

The control plane refuses to classify an action as ENFORCED from SDK flags or
an execution-grant digest alone. Browser actions can now satisfy the narrow
`BROWSER_ENFORCED_V0_2` profile when the full signed grant, runtime claim,
credential-isolated session, event chain, independent outcome, and target
reconciliation bundle passes the central classifier. See
[Browser Enforcement Boundary v0.2](browser-enforcement-boundary.md).

## Browser vertical slice

Run the repository-level end-to-end check with:

```bash
npm run action-assurance:e2e
```

It executes the existing credential-isolated Onegent browser sandbox and
independent outcome probe, uploads the resulting audit packet, issues a signed
Action Assurance Receipt, and verifies it with a standalone trust bundle. The
receipt remains `SELF_REPORTED` / `REPORTED` because it does not use the new
one-time grant protocol. Run `npm run browser-enforcement:e2e` for the v0.2
reference profile and its fail-closed negative cases.

## Examples

Schema and fixtures live under schemas/action-assurance-receipt/v0.1.
Regenerate them after building the control plane:

    npm run build --prefix packages/agentcert-control-plane
    node scripts/generate-action-assurance-fixtures.mjs

The invalid/tampered-receipt.json fixture intentionally has a digest and
signature mismatch. Revoked and disputed fixtures are correctly re-signed with
their lifecycle status.
