# Sandbox Adapter Kit v0.2

Sandbox Adapter Kit turns the local Sandbox Certification Harness into an
integration contract that another team can implement, test, and publish to the
AgentCert Hosted Control Plane without granting production write access.

## Run the reference conformance suite

```bash
npm run onegent:sandbox-conformance
```

Output:

```text
.onegent/sandbox-conformance/sandbox-adapter-conformance.json
```

A passing report uses
`schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2"`. The package
ships `sandbox-adapter-conformance.schema.json` for independent validation.

## Implement a third-party SandboxSystem

Use `createSandboxSystemAdapter()` so the safety declaration and synthetic seed
validation cannot be accidentally weakened:

```ts
const system = createSandboxSystemAdapter({
  name: "customer-sandbox",
  allowedTargetSystems: ["CustomerSandboxCRM"],
  handlers: {
    createTenant,
    deleteTenant,
    resetTenant,
    seedTenant,
    hasTenant,
    snapshotTenant,
    adapterForTenant,
  },
});

const report = await runSandboxAdapterConformanceSuite({ system });
```

The runnable template is
[`examples/onegent/sandbox-system-adapter-template.mjs`](../examples/onegent/sandbox-system-adapter-template.mjs).
The suite actively checks the adapter contract, all ten v0.1 safety controls,
the full tenant lifecycle, and temporary-tenant cleanup.

## Temporary tenants

Every harness tenant receives a one-hour lease by default. The maximum default
lease is 24 hours. Services can shorten these values, renew an active lease,
run deterministic cleanup, or close the harness and delete all remaining
tenants:

```ts
const harness = createSandboxCertificationHarness({
  system,
  tenantTtlMs: 15 * 60_000,
  maxTenantTtlMs: 60 * 60_000,
});

const lease = await harness.createTenant({ id: "pilot-42", synthetic: true });
await harness.renewTenant(lease.tenantId, 10 * 60_000);
await harness.cleanupExpiredTenants();
await harness.close();
```

The in-process timer is a safety net, not a distributed scheduler. A hosted
adapter should also enforce expiry in its own durable store so cleanup survives
process restarts.

## Stripe Test Mode read-only reference

`createStripeTestModeReadOnlyAdapter()` demonstrates the first vendor boundary.
It:

- accepts only an `rk_test_` restricted test-mode key;
- fixes egress to `https://api.stripe.com`;
- exposes only bounded GET operations for PaymentIntents;
- rejects responses unless `livemode` is explicitly `false`;
- returns a narrow snapshot without `client_secret` or metadata.

```ts
const stripe = createStripeTestModeReadOnlyAdapter({
  restrictedApiKey: process.env.STRIPE_RESTRICTED_TEST_KEY!,
});

const snapshot = await stripe.retrievePaymentIntent("pi_...");
```

This adapter does not create, confirm, capture, cancel, or refund payments. The
restricted key must grant only the Stripe read permission required by the
selected method. See Stripe's official [API key guidance](https://docs.stripe.com/keys)
and [PaymentIntent retrieval API](https://docs.stripe.com/api/payment_intents/retrieve).

## Publish certification evidence

The CLI can create a hosted run, upload a manifest-complete evidence bundle,
and complete the run:

```bash
export AGENTCERT_PROJECT_ID="your-project-id"
export AGENTCERT_API_KEY="your-scoped-api-key"
export AGENTCERT_BASE_URL="https://agentcert-control-plane.onrender.com"

onegent-runtime sandbox-conformance --push
```

The API key needs `runs:write` and `evidence:write`. The key is read only from
the environment and is never accepted as a CLI flag or written into evidence.
Programmatic callers can use `uploadSandboxCertificationReport()` with an
injected `fetch` implementation.

## What conformance proves

- the adapter implements the AgentCert synthetic sandbox lifecycle;
- the active safety suite passes against that implementation;
- tenant expiry, cleanup, approval, idempotency, limits, verification, and
  rollback are connected;
- the resulting report can be retained in the Hosted Control Plane with server
  evidence metadata and retention controls.

## What conformance does not prove

- production credentials or vendor production systems are safe;
- an external vendor enforces AgentCert's local controls;
- an irreversible side effect can be rolled back;
- regulatory compliance or independent certification.

The intended progression remains: local synthetic adapter, official vendor
test mode read-only, official vendor sandbox with narrowly approved writes,
production read-only shadow, then a manually approved low-limit canary.
