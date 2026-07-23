# Migration 024 Runbook

Migration `024_browser_enforcement_boundary.sql` adds tenant-bound runtime identities, one-time execution grants, and Browser enforcement sessions. It does not modify existing run, evidence, incident, mandate, action, or receipt rows.

## Before deployment

1. Back up Postgres and record the restore point.
2. Run the control-plane build and test suite.
3. Run the migration against staging twice to verify idempotency.
4. Run `browser-enforcement-postgres.test.ts` with `AGENTCERT_ACCEPTANCE_DATABASE_URL` set to the staging acceptance database.
5. Confirm the Hosted evidence signing key and historical public-key endpoint are healthy.

## Apply

Use the existing control-plane migration runner. Do not paste individual statements selectively. The migration enables RLS on all three tables; application access remains through tenant-authorized service methods.

## Verify

- Runtime identity registration is immutable per key identity.
- Two concurrent distinct claims produce exactly one success.
- An identical claim retry returns the existing session.
- A consumed or revoked grant cannot be claimed.
- Existing Action Assurance receipts remain readable.

## Rollback

Application rollback is safe while no production client depends on Browser v0.2 routes. Preserve the new tables for forensic continuity; disable issuance instead of dropping signed grant/session history. Destructive table removal requires a separately reviewed data-retention decision.
