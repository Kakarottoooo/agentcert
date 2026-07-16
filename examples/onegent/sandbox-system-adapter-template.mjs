import {
  createSandboxSystemAdapter,
  runSandboxAdapterConformanceSuite,
  writeSandboxAdapterConformanceReport,
} from "../../packages/onegent-runtime/dist/index.js";

const tenants = new Map();

const system = createSandboxSystemAdapter({
  name: "example-customer-sandbox",
  allowedTargetSystems: ["ExampleSandboxCRM"],
  handlers: {
    createTenant(input) {
      if (tenants.has(input.id)) throw new Error(`Tenant ${input.id} already exists.`);
      const seed = structuredClone(input.seed ?? {});
      tenants.set(input.id, { seed, state: structuredClone(seed) });
    },
    deleteTenant(tenantId) {
      tenants.delete(tenantId);
    },
    resetTenant(tenantId) {
      const tenant = requiredTenant(tenantId);
      tenant.state = structuredClone(tenant.seed);
    },
    seedTenant(tenantId, seed) {
      const tenant = requiredTenant(tenantId);
      tenant.seed = structuredClone(seed);
      tenant.state = structuredClone(seed);
    },
    hasTenant(tenantId) {
      return tenants.has(tenantId);
    },
    snapshotTenant(tenantId) {
      return structuredClone(requiredTenant(tenantId).state);
    },
    adapterForTenant(tenantId) {
      requiredTenant(tenantId);
      return {
        name: `example-customer-sandbox:${tenantId}`,
        safety: { mode: "sandbox", networkAccess: false, allowedTargetSystems: ["ExampleSandboxCRM"] },
        execute(action) {
          const tenant = requiredTenant(tenantId);
          const previousState = structuredClone(tenant.state[action.businessObjectId] ?? action.beforeState);
          const observedState = structuredClone(action.proposedAfterState);
          tenant.state[action.businessObjectId] = observedState;
          return { method: "CUSTOM_SANDBOX", targetSystem: action.targetSystem, previousState, observedState };
        },
        rollback(action, execution) {
          const restored = structuredClone(execution.previousState ?? action.beforeState);
          requiredTenant(tenantId).state[action.businessObjectId] = restored;
          return { success: true, observedState: restored };
        },
      };
    },
  },
});

const report = await runSandboxAdapterConformanceSuite({ system });
const path = await writeSandboxAdapterConformanceReport(
  report,
  ".onegent/sandbox-conformance/example-customer-adapter.json",
);

console.log(`${report.verdict.passed ? "PASS" : "FAIL"} ${report.verdict.score}/100`);
console.log(path);
if (!report.verdict.passed) process.exitCode = 1;

function requiredTenant(tenantId) {
  const tenant = tenants.get(tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} does not exist.`);
  return tenant;
}
