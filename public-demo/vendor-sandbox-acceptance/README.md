# Public Vendor Sandbox Acceptance

This directory publishes an anonymized view of two real, protected Stripe
sandbox acceptance runs. It intentionally contains no PaymentIntent ID, API
key, Authorization header, client secret, metadata, or raw vendor response.

Source workflow runs:

- https://github.com/Kakarottoooo/agentcert/actions/runs/29481436126
- https://github.com/Kakarottoooo/agentcert/actions/runs/29481517989

`report.json` was generated from only `history.json`, `redaction-scan.json`, and
`artifact-scan.json` using:

```bash
node scripts/build-public-vendor-acceptance.mjs --source <downloaded-artifact-root> --out public-demo/vendor-sandbox-acceptance/report.json
```

The generator does not read the source v0.4 vendor report. It fails closed on
vendor object IDs, credential-shaped values, Authorization values, private key
material, scan findings, digest mismatches, non-passing runs, policy changes,
or a latest trend other than `stable`.
