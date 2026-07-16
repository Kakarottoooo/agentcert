# Production Acceptance Lab

The weekly lab exercises bounded trust boundaries with ephemeral Postgres and Redis services. It runs:

- 100-tenant concurrent isolation stress;
- authenticated JSON API fuzzing;
- Postgres close/reconnect with state recovery;
- Redis close/reconnect with shared idempotency recovery;
- concurrent idempotency and deterministic rate-limit tests;
- webhook failure, bounded retry, DLQ, and explicit replay;
- assurance lifecycle concurrency and reviewer separation;
- the public CLI compatibility suite.

The output is `agentcert.production_acceptance_report.v0.1`. It contains bounded command summaries and an ephemeral Ed25519 signature that self-verifies before the file is written. In the production workflow, the exact report bytes are also uploaded to Hosted evidence; the server SHA-256 and server attestation are recorded in an adjacent receipt.

These drills prove repeatable engineering acceptance in the exercised environment. They are not availability guarantees, penetration tests, or regulatory certifications. Container-level region outages and managed-provider control-plane failures still require scheduled backup/restore and external incident exercises.
