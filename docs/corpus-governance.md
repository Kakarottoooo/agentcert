# Corpus governance v0.1

New corpus records default to `private`. Sharing requires an explicit consent classification and source:

- `private`: retained for the project, excluded from default exports;
- `anonymous`: identity, email, path, and recognized secrets are redacted before export;
- `public`: exportable after the same secret scan, without identity pseudonymization;
- `denied`: the ingestion command refuses to retain the record.

Each governed record carries consent time/source, source-record SHA-256 provenance, collection time, redaction policy version, replacement count, and a passing post-redaction secret scan. Legacy records without governance metadata are excluded from default governed exports.

```bash
npx agentcert corpus ingest --tripwire result.json --consent anonymous --consent-source "pilot agreement 2026-07"
npx agentcert corpus export --consent public,anonymous --out reviewed-share.jsonl
npx agentcert corpus delete --record-id <id> --reason "participant withdrawal"
```

Deletion removes the source record from JSONL, SQLite, or Postgres and appends a tombstone containing only a hash of the record ID, a redacted reason, and deletion time. It does not retain the removed payload.
