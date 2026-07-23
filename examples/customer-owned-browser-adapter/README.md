# Customer-owned browser adapter

This is the safe starter produced by:

```bash
npx agentcert browser-adapter init --adapter agentcert.browser-adapter.mjs
npx agentcert browser-adapter certify --adapter agentcert.browser-adapter.mjs
```

It executes only against local synthetic state while declaring one HTTPS
sandbox origin. Before a pilot, replace the callbacks with the customer's
sandbox execution API, separate read-only outcome API, target audit API, and
secret-provider leases.

The agent never receives either credential. The conformance report stores
credential-reference, observed-state, and audit-event digests, not credential
values or vendor response bodies. Do not connect v0.1 to production systems.
