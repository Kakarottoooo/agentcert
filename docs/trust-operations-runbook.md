# Trust Operations Incident Runbook

This runbook covers production-smoke, Redis coordination, evidence signing,
webhook retry, and dead-letter alerts for the hosted AgentCert control plane.
It is an operator procedure, not evidence that an incident is resolved.

## Alert Matrix

| Alert | Warning | Critical |
| --- | --- | --- |
| Scheduled smoke | No sample in 7 days, or latest pass is older than 36 hours | Latest sample failed, or latest pass is older than 72 hours |
| Redis coordination | None | Redis is not ready or controls are not shared across instances |
| Signing key | Active key is 90-179 days old | No active key, or active key is at least 180 days old |
| Webhook delivery | One or more jobs are retrying | One or more jobs are in the dead-letter queue |

## Initial Triage

1. Open the deduplicated GitHub issue and the linked workflow run.
2. Download the sanitized `agentcert-production-smoke-*` artifact.
3. Confirm the failure time, commit SHA, failed check, and current Render deploy.
4. Open **Dashboard -> Operational overview** and compare the latest smoke,
   Redis, signing-key, retry-rate, latency, and DLQ states.
5. Do not rotate keys, delete evidence, or redrive DLQ jobs until the failed
   subsystem is identified.

## Redis Critical

1. Check Render Key Value availability and the control-plane `REDIS_URL`.
2. Confirm `/health` reports `backend=redis`, `state=ready`, and `shared=true`.
3. If Redis was restarted, verify the application reconnects before rerunning
   smoke. A memory fallback is degraded and is not production acceptance.
4. Rerun **Production trust smoke** manually. Record the new workflow URL in
   the incident.

## Signing Critical Or Warning

1. Confirm `AGENTCERT_EVIDENCE_SIGNING_PRIVATE_KEY` and
   `AGENTCERT_EVIDENCE_SIGNING_KEY_ID` are present in Render without exposing
   their values.
2. For rotation, create a new Ed25519 key and a never-reused key ID, deploy it,
   and confirm the prior public key becomes `retired`, not deleted.
3. Download newly uploaded evidence and verify its attestation against
   `/v1/signing-keys/{keyId}`.
4. Verify evidence signed by the retired key still validates before closing.

## Smoke Failure Or Staleness

1. Identify the first failed check in the sanitized result: health,
   idempotency, evidence roundtrip, signature chain, webhook delivery, or
   operations status.
2. Inspect the corresponding control-plane logs without copying credentials
   into the issue.
3. Fix or roll back the responsible deploy, then dispatch the smoke workflow.
4. Require one passing run and a healthy Dashboard sample newer than 36 hours.

## Webhook Retry Or DLQ

1. Inspect the last response status and error in **Integrations -> Trust operations**.
2. Confirm the receiver is HTTPS, validates AgentCert signatures, and
   deduplicates `X-AgentCert-Event-Id`.
3. Fix receiver availability or validation before selecting **Retry**.
4. Redrive one job first. Confirm delivery latency and retry rate recover before
   redriving additional jobs.

## Closure Evidence

Close the GitHub incident only when it includes the failed workflow, the fix or
rollback commit, a passing workflow URL, current Dashboard status, and any DLQ
redrive result. Keep the sanitized workflow artifacts for their configured
30-day retention. Do not attach private evidence payloads or secrets.
