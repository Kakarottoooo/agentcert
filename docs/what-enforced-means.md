# What `ENFORCED` Means

`ENFORCED` is an execution-boundary claim about one declared action. It means AgentCert verified a one-time authorization grant, a trusted runtime claim, credential-isolated adapter execution, a complete signed event chain, a separate outcome observation, and target-audit reconciliation.

It does not mean:

- the agent is safe for every task;
- the model cannot be manipulated;
- every account or target path was monitored;
- physical or downstream effects outside the predicate were verified;
- the customer environment is free of alternate credentials;
- the action was correct merely because it was authorized and controlled.

The receipt separates three questions:

| Field | Question |
| --- | --- |
| `enforcementLevel` | Was this action forced through the declared execution boundary? |
| `evidenceStrength` | How strong is the best supported evidence claim? |
| `outcomeAttestation.result` | Did independently observed state satisfy the declared predicate? |

An enforced action can have `NOT_SATISFIED` outcome evidence. Conversely, an observed successful outcome is not automatically enforced.

Consumers verifying an `ENFORCED` receipt must provide the referenced Browser enforcement bundle and current or historical runtime identity key. Cryptographic receipt verification without those proof objects returns review-required rather than silently accepting the enforcement claim.
