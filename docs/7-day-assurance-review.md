# 7-Day Agent Action Assurance Review

This is AgentCert's fixed-scope paid review for a consequential agent workflow.
It is an independent, evidence-backed release decision, not a legal compliance
certification and not a guarantee that the agent cannot fail.

## Commercial boundary

- Price: **$5,000 USD**.
- Scope: **one agent version, one sandbox, and one workflow**.
- Retest: **one remediation retest is included**.
- Privacy: **private by default**. AgentCert publishes customer names, results,
  screenshots, traces, or failure data only after written approval.
- Delivery: seven calendar days after the engagement plan is locked, subject to
  timely sandbox access and a reproducible workflow.

Additional workflows, versions, environments, or recurring regressions require
a separate written scope. AgentCert does not request production write
credentials and does not begin with live payment, email, or irreversible
systems.

## Locked input

The engagement record captures and hashes:

1. Customer and agent version.
2. Sandbox name, kind, and optional URL.
3. One workflow and its high-risk action.
4. The expected observable outcome.
5. Required evidence, controls, limitations, and policy-pack version.
6. The seven-day due date and integration start time.

The evaluation plan cannot be edited after creation. A changed agent version or
workflow is a new review, not a retroactive update.

## Review flow

1. Record an immutable baseline evidence set.
2. Identify the first behavior divergence, authorization gaps, and outcome.
3. Record remediation items.
4. Record one distinct retest evidence set.
5. A reviewer other than the case creator issues one formal decision:
   `RELEASE`, `RELEASE_WITH_CONTROLS`, or `BLOCK`.
6. AgentCert signs the delivery packet with the active server attestation key.

`RELEASE` requires an independently verified outcome and no remaining required
controls. `RELEASE_WITH_CONTROLS` requires explicit controls. `BLOCK` states why
the declared workflow should not be released in its reviewed form.

## Delivery packet

The machine-readable `agentcert.assurance_delivery.v0.1` packet includes:

- customer, subject version, sandbox, workflow, due date, and fixed terms;
- locked evaluation-plan SHA-256;
- baseline and retest evidence IDs, SHA-256 digests, sizes, and kinds;
- remediation items;
- decision, rationale, first divergence, and authorization gaps;
- expected and independently observed outcome;
- required controls and explicit limitations;
- integration start, first valid evidence time, and elapsed seconds;
- declared evidence-strength level; and
- AgentCert's Ed25519 server attestation.

Validate a downloaded packet with:

```bash
npx agentcert schema validate \
  --schema assurance-delivery \
  --file agentcert-assurance-delivery.json
```

The JSON Schema is [agentcert-assurance-delivery.schema.json](../schemas/agentcert-assurance-delivery.schema.json).
