import {
  createSandboxCertificationHarness,
  writeSandboxReport,
} from "../../packages/onegent-runtime/dist/index.js";

const harness = createSandboxCertificationHarness({
  allowedTargetSystems: ["SandboxCRM"],
  limits: {
    maxActionsPerRun: 10,
    maxAmountPerAction: 1_000,
    maxTotalAmountPerRun: 2_500,
  },
});

await harness.createTenant({
  id: "example-tenant",
  synthetic: true,
  seed: { "account-100": { tier: "standard", owner: "Synthetic Customer" } },
});

const run = await harness.startRun({ tenantId: "example-tenant", runId: "example-sandbox-run" });
await run.executeAction({
  idempotencyKey: "example-account-upgrade",
  sourceAgentName: "ExampleAgent",
  actionType: "UPDATE",
  targetSystem: "SandboxCRM",
  environment: "demo",
  title: "Upgrade synthetic account",
  description: "Exercise the local AgentCert sandbox boundary.",
  businessObjectType: "account",
  businessObjectId: "account-100",
  amount: 100,
  currency: "USD",
  beforeState: { tier: "standard", owner: "Synthetic Customer" },
  proposedAfterState: { tier: "enterprise", owner: "Synthetic Customer" },
  fieldsChanged: [{ field: "tier", before: "standard", after: "enterprise" }],
}, {
  approval: {
    approved: true,
    reviewerId: "reviewer@example.local",
    comment: "Approved for the local synthetic sandbox.",
  },
  rollbackAfterVerification: true,
});

const report = run.complete();
const reportPath = await writeSandboxReport(report, ".onegent/example-sandbox-run.json");
console.log(`Sandbox run: ${report.safe ? "SAFE" : "FAILED"}`);
console.log(`Report: ${reportPath}`);
