import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ADAPTER_PATH = "agentcert.browser-adapter.mjs";
const DEFAULT_REPORT_PATH = ".agentcert/browser-adapter/conformance.json";

interface BrowserAdapterRuntime {
  createCustomerOwnedBrowserAdapterKit(config: Record<string, unknown>): BrowserAdapterKit;
  runCustomerOwnedBrowserAdapterConformance(input: {
    kit: BrowserAdapterKit;
    fixture: BrowserAdapterFixture;
  }): Promise<BrowserAdapterReport>;
}

interface BrowserAdapterKit {
  name: string;
  prepareExecution(): Promise<unknown>;
}

interface BrowserAdapterFixture {
  action: Record<string, unknown>;
  expectedObservedState: Record<string, unknown>;
  expectedAudit: Record<string, unknown>;
  forbiddenSecrets?: string[];
}

interface BrowserAdapterModule {
  browserAdapterKit?: BrowserAdapterKit;
  browserAdapterConfig?: Record<string, unknown>;
  browserAdapterFixture: BrowserAdapterFixture;
}

interface BrowserAdapterReport {
  schemaVersion: "agentcert.customer_browser_adapter_conformance.v0.1";
  kind: "agentcert.customer_browser_adapter_conformance";
  verdict: { passed: boolean; score: number };
  checks: Array<{ id: string; status: "passed" | "failed"; message: string }>;
  [key: string]: unknown;
}

export interface BrowserAdapterCommandResult {
  exitCode: number;
  reportPath?: string;
  report?: BrowserAdapterReport;
}

export async function runBrowserAdapterCommand(args: string[]): Promise<BrowserAdapterCommandResult> {
  const action = args[0] ?? "help";
  if (action === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(renderBrowserAdapterHelp(action === "help" ? undefined : action));
    return { exitCode: 0 };
  }
  if (action === "init") return initializeBrowserAdapter(args.slice(1));
  if (action === "certify") return certifyBrowserAdapter(args.slice(1));
  throw new Error(`Unknown browser-adapter command ${JSON.stringify(action)}. Run \`npx agentcert browser-adapter --help\`.`);
}

export async function initializeBrowserAdapter(args: string[]): Promise<BrowserAdapterCommandResult> {
  const requestedPath = flag(args, "--adapter") ?? flag(args, "--out") ?? DEFAULT_ADAPTER_PATH;
  const outPath = resolve(requestedPath);
  await writeStarterFile(outPath, browserAdapterTemplate(), args.includes("--force"));
  process.stdout.write(`Wrote ${outPath}\n\nNext:\n  npx agentcert browser-adapter certify --adapter ${JSON.stringify(requestedPath)}\n`);
  process.stdout.write("\nThe generated adapter is synthetic and sandbox-only. Replace its callbacks with your customer-owned sandbox boundary before pilot use.\n");
  return { exitCode: 0 };
}

export async function certifyBrowserAdapter(
  args: string[],
  runtimeOverride?: BrowserAdapterRuntime,
  adapterOverride?: BrowserAdapterModule,
): Promise<BrowserAdapterCommandResult> {
  const runtime = runtimeOverride ?? await loadRuntime();
  const adapterPath = resolve(flag(args, "--adapter") ?? DEFAULT_ADAPTER_PATH);
  const adapterModule = adapterOverride ?? await loadAdapter(adapterPath);
  const kit = adapterModule.browserAdapterKit
    ?? runtime.createCustomerOwnedBrowserAdapterKit(adapterModule.browserAdapterConfig!);
  const report = await runtime.runCustomerOwnedBrowserAdapterConformance({
    kit,
    fixture: adapterModule.browserAdapterFixture,
  });
  const reportPath = resolve(flag(args, "--out") ?? DEFAULT_REPORT_PATH);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${report.verdict.passed ? "PASS" : "FAIL"} ${report.verdict.score}/100 customer-owned browser adapter conformance\n`);
  for (const check of report.checks) process.stdout.write(`- ${check.status === "passed" ? "PASS" : "FAIL"} ${check.id}: ${check.message}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
  return { exitCode: report.verdict.passed ? 0 : 1, reportPath, report };
}

export function renderBrowserAdapterHelp(action?: string): string {
  if (action === "init") return `Usage:\n  agentcert browser-adapter init [--adapter agentcert.browser-adapter.mjs] [--force]\n\nWrites a safe, customer-owned browser sandbox adapter template.\n`;
  if (action === "certify") return `Usage:\n  agentcert browser-adapter certify --adapter ./agentcert.browser-adapter.mjs [--out .agentcert/browser-adapter/conformance.json]\n\nChecks the gateway boundary, allowlists, credential separation, outcome probe, target audit match, revocation, and report redaction.\n`;
  return `Usage:\n  agentcert browser-adapter init [--adapter agentcert.browser-adapter.mjs]\n  agentcert browser-adapter certify --adapter ./agentcert.browser-adapter.mjs\n\nCommands:\n  init      Write a sandbox-only adapter and deterministic fixture\n  certify   Run local boundary and evidence conformance\n`;
}

async function loadRuntime(): Promise<BrowserAdapterRuntime> {
  try {
    return await import(new URL("./vendor/onegent-runtime/browser-adapter-kit.js", import.meta.url).href) as BrowserAdapterRuntime;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ERR_MODULE_NOT_FOUND") throw new Error("AgentCert browser adapter runtime is missing. Reinstall agentcert and retry.");
    throw error;
  }
}

async function loadAdapter(adapterPath: string): Promise<BrowserAdapterModule> {
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(adapterPath).href) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not load browser adapter ${adapterPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hasKit = isRecord(module.browserAdapterKit) && typeof module.browserAdapterKit.prepareExecution === "function";
  if ((!hasKit && !isRecord(module.browserAdapterConfig)) || !isRecord(module.browserAdapterFixture)) {
    throw new Error(`${adapterPath} must export browserAdapterConfig (or a legacy browserAdapterKit) and browserAdapterFixture.`);
  }
  return module as unknown as BrowserAdapterModule;
}

function browserAdapterTemplate(): string {
  return `// Safe starter: local synthetic sandbox state. Never point v0.1 at production.
const WRITE_SECRET = process.env.BROWSER_SANDBOX_WRITE_KEY ?? "synthetic-write-credential";
const READ_SECRET = process.env.BROWSER_SANDBOX_READ_KEY ?? "synthetic-read-credential";
let state = { status: "DRAFT", reference: "ORDER-DEMO-1" };
const audit = [];
const parametersDigest = "fixture-parameters-sha256";

export const browserAdapterConfig = {
  name: "customer-browser-sandbox",
  targetSystem: "CustomerBrowserSandbox",
  allowedOrigins: ["https://sandbox.example.test"],
  allowedActionTypes: ["SUBMIT"],
  allowedOperation: "order.submit",
  allowedResource: "order:ORDER-DEMO-1",
  sandbox: true,
  resolveWriteCredential() {
    return { reference: "secret-provider://browser/write", secret: WRITE_SECRET, expiresAt: futureExpiry() };
  },
  resolveReadCredential() {
    return { reference: "secret-provider://browser/read", secret: READ_SECRET, expiresAt: futureExpiry() };
  },
  execute({ action, context, credential }) {
    if (credential !== WRITE_SECRET) throw new Error("Write credential boundary failed.");
    const previousState = structuredClone(state);
    state = structuredClone(action.proposedAfterState);
    audit.splice(0, audit.length, {
      targetEventId: "audit-1", actionId: action.id, executionSessionId: context.idempotencyKey,
      occurredAt: new Date().toISOString(), operation: "order.submit", resource: "order:ORDER-DEMO-1",
      parametersDigest, credentialReferenceDigest: "write-reference-digest",
    });
    return { method: "LOCAL_ADAPTER", targetSystem: action.targetSystem, previousState, observedState: structuredClone(state) };
  },
  observe({ credential }) {
    if (credential !== READ_SECRET) throw new Error("Read credential boundary failed.");
    return { observationId: "observation-1", observedAt: new Date().toISOString(), observedState: structuredClone(state), source: "customer-sandbox-read-api" };
  },
  listAuditEvents({ credential }) {
    if (credential !== READ_SECRET) throw new Error("Audit credential boundary failed.");
    return structuredClone(audit);
  },
  revokeWriteCredential() {},
};

export const browserAdapterFixture = {
  action: {
    id: "action-demo-1", idempotencyKey: "adapter-demo-1", workspaceId: "local", workflowId: "browser-adapter-conformance",
    sourceAgentName: "customer-browser-agent", principal: { id: "customer-browser-agent", type: "agent", version: "1.0.0" },
    requestedPermissions: ["order.submit"], actionType: "SUBMIT", targetSystem: "CustomerBrowserSandbox",
    targetUrl: "https://sandbox.example.test/orders/ORDER-DEMO-1", environment: "staging", title: "Submit sandbox order",
    description: "Conformance-only synthetic order submission.", businessObjectType: "order", businessObjectId: "ORDER-DEMO-1",
    beforeState: { status: "DRAFT", reference: "ORDER-DEMO-1" }, proposedAfterState: { status: "SUBMITTED", reference: "ORDER-DEMO-1" },
    fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }], createdAt: new Date().toISOString(), status: "APPROVED",
  },
  expectedObservedState: { status: "SUBMITTED", reference: "ORDER-DEMO-1" },
  expectedAudit: { operation: "order.submit", resource: "order:ORDER-DEMO-1", parametersDigest },
  forbiddenSecrets: [WRITE_SECRET, READ_SECRET],
};

function futureExpiry() { return new Date(Date.now() + 10 * 60_000).toISOString(); }
`;
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
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error(`${path} already exists. Re-run with --force to overwrite it.`);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
