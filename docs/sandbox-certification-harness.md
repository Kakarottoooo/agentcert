# Sandbox Certification Harness v0.1

Sandbox Certification Harness is the local-only safety boundary for exercising
agent write actions before any vendor sandbox or production system is involved.
It lives in `@agentcert/onegent-runtime` and reuses Onegent approval,
idempotency, verification, rollback, and audit contracts.

## Quick certification

```bash
npm run onegent:sandbox-certify
```

The command actively tests ten controls and writes:

```text
.onegent/sandbox-certification/sandbox-certification.json
```

A passing report uses
`schemaVersion: "agentcert.sandbox_certification.v0.1"`. The JSON Schema ships
as `packages/onegent-runtime/sandbox-certification.schema.json` and is included
in the runtime package.

## Controls exercised

| Control | Active check |
|---|---|
| Tenant isolation | A run scoped to tenant A attempts to name tenant B and must be rejected. |
| Synthetic data only | Credential-like keys and values in seed data must be rejected. |
| Deny network egress | An action with `targetUrl` must be rejected before execution. |
| Target allowlist | A non-allowlisted target system must be rejected. |
| Production deny | An action with `environment: "production"` must be rejected. |
| Approval gate | Every mutation must carry an identified reviewer decision. |
| Execution limits | Per-action amount, cumulative run amount, and action-count limits fail closed. |
| Kill switches | Both tenant and global kill switches stop new execution. |
| Idempotency | Concurrent identical retries share one action result; conflicting reuse is rejected. |
| Verification and recovery | Expected state is verified, rollback restores the snapshot, and reset restores the seed. |

## Embed the harness

```ts
import { createSandboxCertificationHarness } from "@agentcert/onegent-runtime";

const harness = createSandboxCertificationHarness({
  allowedTargetSystems: ["SandboxCRM"],
  limits: {
    maxActionsPerRun: 10,
    maxAmountPerAction: 1_000,
    maxTotalAmountPerRun: 2_500,
  },
});

await harness.createTenant({
  id: "customer-demo",
  synthetic: true,
  seed: { "account-100": { tier: "standard" } },
});

const run = await harness.startRun({ tenantId: "customer-demo" });
const result = await run.executeAction(action, {
  approval: {
    approved: true,
    reviewerId: "reviewer@example.local",
  },
  rollbackAfterVerification: true,
});
const report = run.complete();
```

Every action must provide an explicit `idempotencyKey`. Safety rejections are
returned as structured `SandboxRejectionCode` values rather than ambiguous
adapter errors. Callers should execute through the harness; `SandboxSystem` is
the low-level lifecycle contract for reference and future vendor-sandbox
adapters.

## Lifecycle

1. Create an isolated tenant with declared synthetic seed data.
2. Start a bounded run.
3. Submit an action with an explicit idempotency key and reviewer decision.
4. Execute only against an allowlisted local target with no network access.
5. Verify expected state against observed state.
6. Roll back when requested and emit the Onegent audit packet.
7. Complete the run and retain its report, or reset the tenant to its seed.

## What this proves

- the reference sandbox enforces the ten v0.1 controls deterministically;
- an action cannot reach the reference state adapter through the harness without
  tenant scope, allowlisting, limits, idempotency, and approval;
- execution, observed-state verification, rollback, and audit evidence are
  connected in one local workflow.

## What this does not prove

- that a production integration is safe;
- that external credentials, vendor APIs, payments, email, or portals were
  tested;
- that rollback can reverse an irreversible real-world side effect;
- regulatory compliance or third-party certification.

## Path to a customer sandbox

Keep the same `SandboxSystem` contract and move in stages: local simulator,
isolated official vendor sandbox, production read-only shadow mode, then a
manually approved low-limit canary. A vendor adapter must use a separate test
account, short-lived least-privilege credentials, explicit egress allowlists,
deterministic reset, independent read-after-write verification, and a kill
switch. Real payment or broad production write access is not a valid first
integration.

## Adapter Kit v0.2

Third-party implementations should use `createSandboxSystemAdapter()` and run
`runSandboxAdapterConformanceSuite()`. The v0.2 layer adds bounded tenant
leases, automatic cleanup, a Stripe Test Mode read-only reference, and Hosted
Control Plane evidence upload without changing the v0.1 ten-control report.

See [Sandbox Adapter Kit v0.2](sandbox-adapter-kit.md).
