# Backup and restore drill

The drill restores production-like data into a separate disposable database, compares counts for core tenant/evidence tables, and writes a secret-free JSON report. It never restores over the source database.

## Protected GitHub environment

Create an environment named `backup-restore` with required reviewer approval. Configure:

- Secret `AGENTCERT_BACKUP_SOURCE_DATABASE_URL`: read-capable source connection.
- Secret `AGENTCERT_RESTORE_DATABASE_URL`: disposable target database; its database name must contain `restore`, `drill`, or `sandbox`.
- Variable `AGENTCERT_RESTORE_CONFIRM`: exact target database name.

Run **Backup restore drill** manually. Review table counts and elapsed workflow time, record measured RTO, then destroy or reset the target. The report contains only database host/name metadata and row counts; it never contains passwords or rows.

## Failure handling

1. Do not retry against a differently named database until the target is verified.
2. Preserve the failed workflow log and report as incident evidence.
3. Classify whether the failure occurred during dump, restore, schema compatibility, or count reconciliation.
4. Fix and rerun against a fresh disposable target.
5. A successful dump without a successful restore is not a passed backup test.
