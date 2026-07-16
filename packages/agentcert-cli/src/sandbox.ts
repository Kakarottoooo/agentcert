import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConnection } from "./credentials.js";

const DEFAULT_ADAPTER_PATH = "agentcert.sandbox.mjs";
const DEFAULT_REPORT_PATH = ".agentcert/sandbox/sandbox-adapter-conformance.json";
const DEFAULT_STRIPE_REPORT_PATH = ".agentcert/sandbox/stripe-readonly-report.json";

interface SandboxSafety {
  mode: "sandbox";
  networkAccess: false;
  syntheticDataOnly: true;
  allowedTargetSystems: readonly string[];
}

interface SandboxSystem {
  name: string;
  safety: SandboxSafety;
  createTenant(input: unknown): unknown;
  deleteTenant(tenantId: string): unknown;
  resetTenant(tenantId: string): unknown;
  seedTenant(tenantId: string, seed: unknown): unknown;
  hasTenant(tenantId: string): unknown;
  snapshotTenant(tenantId: string): unknown;
  adapterForTenant(tenantId: string): unknown;
}

interface SandboxConformanceReport {
  schemaVersion: string;
  kind: "agentcert.sandbox_adapter_conformance";
  implementation: string;
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: Array<{ id: string; status: "passed" | "failed"; message: string }>;
}

interface StripeSandboxReadOnlyReport {
  schemaVersion: "agentcert.sandbox_vendor_egress.v0.4";
  kind: "agentcert.sandbox_vendor_egress";
  implementation: "stripe-payment-intent-readonly";
  vendor: "stripe";
  environment: "sandbox";
  generatedAt: string;
  verdict: { passed: boolean; score: number };
  summary: { passed: number; failed: number; total: number };
  checks: Array<{ id: string; status: "passed" | "failed"; message: string }>;
  policy: Record<string, unknown>;
  audit: Array<Record<string, unknown>>;
  observation?: Record<string, unknown>;
  disclaimer: string;
}

type SandboxReport = SandboxConformanceReport | StripeSandboxReadOnlyReport;

interface SandboxRuntimeModule {
  runSandboxAdapterConformanceSuite(options: {
    system: SandboxSystem;
    implementation?: string;
    targetSystem?: string;
  }): Promise<SandboxConformanceReport>;
  writeSandboxAdapterConformanceReport(report: SandboxConformanceReport, filePath: string): Promise<string>;
  runStripeSandboxReadOnlyCertification?(options: {
    restrictedApiKey: string;
    paymentIntentId: string;
  }): Promise<StripeSandboxReadOnlyReport>;
  uploadSandboxCertificationReport(report: SandboxReport, options: {
    baseUrl: string;
    projectId: string;
    apiKey: string;
    externalId?: string;
  }): Promise<{ run: Record<string, unknown>; evidence: Record<string, unknown> }>;
}

export interface SandboxCommandResult {
  exitCode: number;
  reportPath?: string;
  report?: SandboxReport;
}

export async function runSandboxCommand(args: string[]): Promise<SandboxCommandResult> {
  const action = args[0] ?? "help";
  if (action === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(renderSandboxHelp(action === "help" ? undefined : action));
    return { exitCode: 0 };
  }
  if (action === "init") return initializeSandboxAdapter(args.slice(1));
  if (action === "certify") return certifySandboxAdapter(args.slice(1));
  if (action === "push") return pushSandboxCertification(args.slice(1));
  if (action === "stripe-readonly") return runStripeSandboxReadOnly(args.slice(1));
  throw new Error(`Unknown sandbox command ${JSON.stringify(action)}. Run \`npx agentcert sandbox --help\`.`);
}

export async function initializeSandboxAdapter(args: string[]): Promise<SandboxCommandResult> {
  const requestedPath = flag(args, "--adapter") ?? flag(args, "--out") ?? DEFAULT_ADAPTER_PATH;
  const outPath = resolve(requestedPath);
  await writeStarterFile(outPath, sandboxAdapterTemplate(), args.includes("--force"));
  process.stdout.write(`Wrote ${outPath}\n\nNext:\n`);
  process.stdout.write(`  npx agentcert sandbox certify --adapter ${JSON.stringify(requestedPath)}\n`);
  process.stdout.write("\nReplace the in-memory handlers with your sandbox implementation. Keep production credentials and live systems out of this adapter.\n");
  return { exitCode: 0 };
}

export async function certifySandboxAdapter(
  args: string[],
  runtimeOverride?: SandboxRuntimeModule,
): Promise<SandboxCommandResult> {
  const runtime = runtimeOverride ?? await loadSandboxRuntime();
  const adapterPath = resolve(flag(args, "--adapter") ?? DEFAULT_ADAPTER_PATH);
  const reportPath = resolve(flag(args, "--out") ?? DEFAULT_REPORT_PATH);
  const system = await loadSandboxAdapter(adapterPath);
  const report = await runtime.runSandboxAdapterConformanceSuite({
    system,
    implementation: flag(args, "--implementation"),
    targetSystem: flag(args, "--target-system"),
  });
  await runtime.writeSandboxAdapterConformanceReport(report, reportPath);
  renderCertificationResult(report, reportPath);
  return { exitCode: report.verdict.passed ? 0 : 1, reportPath, report };
}

export async function pushSandboxCertification(
  args: string[],
  runtimeOverride?: SandboxRuntimeModule,
): Promise<SandboxCommandResult> {
  const runtime = runtimeOverride ?? await loadSandboxRuntime();
  const certified = await certifySandboxAdapter(args, runtime);
  if (!certified.report || !certified.reportPath) throw new Error("Sandbox certification did not produce a report.");
  const connection = await resolveConnection({
    name: flag(args, "--connection"),
    server: flag(args, "--server"),
    projectId: flag(args, "--project"),
    apiKey: flag(args, "--api-key"),
  });
  const uploaded = await runtime.uploadSandboxCertificationReport(certified.report, {
    baseUrl: connection.server,
    projectId: connection.projectId,
    apiKey: connection.apiKey,
    externalId: flag(args, "--external-id"),
  });
  process.stdout.write(`Hosted sandbox run: ${String(uploaded.run.id ?? "created")}\n`);
  process.stdout.write(`Hosted evidence: ${String(uploaded.evidence.id ?? "created")}\n`);
  return certified;
}

export async function runStripeSandboxReadOnly(
  args: string[],
  runtimeOverride?: SandboxRuntimeModule,
): Promise<SandboxCommandResult> {
  if (args.includes("--stripe-key") || args.includes("--restricted-key")) {
    throw new Error("Stripe credentials are accepted only through STRIPE_RESTRICTED_TEST_KEY, never a CLI flag.");
  }
  const paymentIntentId = flag(args, "--payment-intent");
  if (!paymentIntentId) throw new Error("Stripe sandbox read requires --payment-intent <pi_...>.");
  const restrictedApiKey = process.env.STRIPE_RESTRICTED_TEST_KEY?.trim();
  if (!restrictedApiKey) {
    throw new Error("Set STRIPE_RESTRICTED_TEST_KEY to a read-only Stripe rk_test_ restricted key.");
  }
  const runtime = runtimeOverride ?? await loadSandboxRuntime();
  if (!runtime.runStripeSandboxReadOnlyCertification) {
    throw new Error("AgentCert Stripe sandbox runtime is missing. Reinstall the agentcert package and retry.");
  }
  const report = await runtime.runStripeSandboxReadOnlyCertification({ restrictedApiKey, paymentIntentId });
  const reportPath = resolve(flag(args, "--out") ?? DEFAULT_STRIPE_REPORT_PATH);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renderVendorReadResult(report, reportPath);

  if (args.includes("--push")) {
    const connection = await resolveConnection({
      name: flag(args, "--connection"),
      server: flag(args, "--server"),
      projectId: flag(args, "--project"),
      apiKey: flag(args, "--api-key"),
    });
    const uploaded = await runtime.uploadSandboxCertificationReport(report, {
      baseUrl: connection.server,
      projectId: connection.projectId,
      apiKey: connection.apiKey,
      externalId: flag(args, "--external-id"),
    });
    process.stdout.write(`Hosted sandbox run: ${String(uploaded.run.id ?? "created")}\n`);
    process.stdout.write(`Hosted evidence: ${String(uploaded.evidence.id ?? "created")}\n`);
  }
  return { exitCode: report.verdict.passed ? 0 : 1, reportPath, report };
}

export async function loadSandboxAdapter(adapterPath: string): Promise<SandboxSystem> {
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(adapterPath).href) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load sandbox adapter ${adapterPath}: ${message}`);
  }
  const candidate = module.sandboxSystem ?? module.default ?? module.system;
  if (!isSandboxSystem(candidate)) {
    throw new Error(
      `Sandbox adapter ${adapterPath} must export \`sandboxSystem\`, \`system\`, or a default SandboxSystem object.`,
    );
  }
  return candidate;
}

export function renderSandboxHelp(action?: string): string {
  if (action === "init") return `Usage:
  agentcert sandbox init [--adapter agentcert.sandbox.mjs] [--force]

Writes one dependency-free synthetic SandboxSystem adapter template.
`;
  if (action === "certify") return `Usage:
  agentcert sandbox certify --adapter ./my-sandbox-adapter.js [--out .agentcert/sandbox/report.json]

Runs the deterministic sandbox adapter conformance suite locally.
`;
  if (action === "push") return `Usage:
  agentcert sandbox push --adapter ./my-sandbox-adapter.js

Runs certification, writes the local report, and uploads it through the saved AgentCert connection.
Use \`agentcert connect\` first, or pass --server, --project, and --api-key.
`;
  if (action === "stripe-readonly") return `Usage:
  STRIPE_RESTRICTED_TEST_KEY=rk_test_... agentcert sandbox stripe-readonly --payment-intent pi_...
  agentcert sandbox stripe-readonly --payment-intent pi_... --push

Reads one Stripe sandbox PaymentIntent through a fixed GET/resource allowlist,
writes a redacted evidence report, and optionally uploads it to AgentCert Hosted.
The Stripe key is read only from STRIPE_RESTRICTED_TEST_KEY.
`;
  return `Usage:
  agentcert sandbox init [--adapter agentcert.sandbox.mjs]
  agentcert sandbox certify --adapter ./my-sandbox-adapter.js
  agentcert sandbox push --adapter ./my-sandbox-adapter.js
  agentcert sandbox stripe-readonly --payment-intent pi_... [--push]

Commands:
  init      Write one dependency-free adapter template
  certify   Run deterministic local conformance checks
  push      Certify and upload the report to AgentCert Hosted
  stripe-readonly  Run one bounded Stripe sandbox read and write evidence

Common options:
  --adapter <path>        Adapter module (default: agentcert.sandbox.mjs)
  --out <path>            Local report path
  --implementation <id>  Stable adapter implementation name
  --target-system <name> Target system exercised by the suite
`;
}

async function loadSandboxRuntime(): Promise<SandboxRuntimeModule> {
  const adapterKitUrl = new URL("./vendor/onegent-runtime/sandbox-adapter-kit.js", import.meta.url);
  const hostedUrl = new URL("./vendor/onegent-runtime/sandbox-hosted.js", import.meta.url);
  const stripeUrl = new URL("./vendor/onegent-runtime/stripe-test-readonly.js", import.meta.url);
  try {
    const [adapterKit, hosted, stripe] = await Promise.all([
      import(adapterKitUrl.href),
      import(hostedUrl.href),
      import(stripeUrl.href),
    ]);
    return { ...adapterKit, ...hosted, ...stripe } as SandboxRuntimeModule;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("AgentCert sandbox runtime is missing. Reinstall the agentcert package and retry.");
    }
    throw error;
  }
}

function isSandboxSystem(value: unknown): value is SandboxSystem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const system = value as Partial<SandboxSystem>;
  const safety = system.safety;
  return typeof system.name === "string"
    && safety?.mode === "sandbox"
    && safety.networkAccess === false
    && safety.syntheticDataOnly === true
    && Array.isArray(safety.allowedTargetSystems)
    && ["createTenant", "deleteTenant", "resetTenant", "seedTenant", "hasTenant", "snapshotTenant", "adapterForTenant"]
      .every((method) => typeof system[method as keyof SandboxSystem] === "function");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function writeStarterFile(path: string, content: string, force: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: force ? "w" : "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`${path} already exists. Re-run with --force to overwrite it.`);
    }
    throw error;
  }
}

function renderCertificationResult(report: SandboxConformanceReport, reportPath: string): void {
  process.stdout.write(`${report.verdict.passed ? "PASS" : "FAIL"} ${report.verdict.score}/100 sandbox adapter conformance\n`);
  for (const check of report.checks) {
    process.stdout.write(`- ${check.status === "passed" ? "PASS" : "FAIL"} ${check.id}: ${check.message}\n`);
  }
  process.stdout.write(`Report: ${reportPath}\n`);
}

function renderVendorReadResult(report: StripeSandboxReadOnlyReport, reportPath: string): void {
  process.stdout.write(`${report.verdict.passed ? "PASS" : "FAIL"} ${report.verdict.score}/100 Stripe sandbox bounded read\n`);
  for (const check of report.checks) {
    process.stdout.write(`- ${check.status === "passed" ? "PASS" : "FAIL"} ${check.id}: ${check.message}\n`);
  }
  process.stdout.write(`Requests audited: ${report.audit.length}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
}

function sandboxAdapterTemplate(): string {
  return `// Synthetic local state only. Do not import production credentials or call live systems here.
const tenants = new Map();

export const sandboxSystem = {
  name: "my-sandbox-adapter",
  safety: {
    mode: "sandbox",
    networkAccess: false,
    syntheticDataOnly: true,
    allowedTargetSystems: ["MySandboxSystem"],
  },
  createTenant(input) {
    if (input.synthetic !== true) throw new Error("Synthetic tenants only.");
    if (tenants.has(input.id)) throw new Error(\`Tenant \${input.id} already exists.\`);
    const seed = syntheticSeed(input.seed ?? {});
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
    tenant.seed = syntheticSeed(seed);
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
      name: \`my-sandbox-adapter:\${tenantId}\`,
      safety: { mode: "sandbox", networkAccess: false, allowedTargetSystems: ["MySandboxSystem"] },
      execute(action) {
        const tenant = requiredTenant(tenantId);
        const previousState = structuredClone(tenant.state[action.businessObjectId] ?? action.beforeState);
        const observedState = structuredClone(action.proposedAfterState);
        tenant.state[action.businessObjectId] = observedState;
        return { method: "SYNTHETIC_SANDBOX", targetSystem: action.targetSystem, previousState, observedState };
      },
      rollback(action, execution) {
        const restored = structuredClone(execution.previousState ?? action.beforeState);
        requiredTenant(tenantId).state[action.businessObjectId] = restored;
        return { success: true, observedState: restored };
      },
    };
  },
};

export default sandboxSystem;

function requiredTenant(tenantId) {
  const tenant = tenants.get(tenantId);
  if (!tenant) throw new Error(\`Tenant \${tenantId} does not exist.\`);
  return tenant;
}

function syntheticSeed(value) {
  assertSynthetic(value, "seed", new Set());
  return structuredClone(value);
}

function assertSynthetic(value, path, seen) {
  if (value === null || ["boolean", "number"].includes(typeof value)) return;
  if (typeof value === "string") {
    if (/^(?:sk-(?:proj-)?|npm_|gh[pousr]_)[A-Za-z0-9_-]{16,}$/.test(value)) {
      throw new Error(\`Credential-like value is not allowed at \${path}.\`);
    }
    return;
  }
  if (typeof value !== "object") throw new Error(\`Synthetic data must be JSON-compatible at \${path}.\`);
  if (seen.has(value)) throw new Error(\`Synthetic data cannot contain cycles at \${path}.\`);
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|passwd|secret|token|api[_-]?key|credential|authorization|cookie)/i.test(key)) {
      throw new Error(\`Credential-like field \${path}.\${key} is not allowed.\`);
    }
    assertSynthetic(item, \`\${path}.\${key}\`, seen);
  }
  seen.delete(value);
}
`;
}
