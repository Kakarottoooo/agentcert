import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSandboxAdapterConformanceSuite } from "../../onegent-runtime/src/sandbox-adapter-kit.js";
import {
  initializeSandboxAdapter,
  loadSandboxAdapter,
  pushSandboxCertification,
  runStripeSandboxReadOnly,
} from "../src/sandbox.js";

const temporaryDirectories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnvironment };
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("unified sandbox onboarding", () => {
  it("writes one dependency-free adapter that passes the real conformance suite", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const directory = await temporaryDirectory();
    const adapterPath = join(directory, "agentcert.sandbox.mjs");

    await initializeSandboxAdapter(["--adapter", adapterPath]);

    const source = await readFile(adapterPath, "utf8");
    expect(source).not.toContain("@agentcert/");
    const system = await loadSandboxAdapter(adapterPath);
    const report = await runSandboxAdapterConformanceSuite({ system });
    expect(report.verdict).toEqual({ passed: true, score: 100 });
    expect(report.summary).toEqual({ passed: 4, failed: 0, total: 4 });
  });

  it("certifies and uploads through the existing hosted connection contract", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const directory = await temporaryDirectory();
    const adapterPath = join(directory, "adapter.mjs");
    const reportPath = join(directory, "report.json");
    await writeFile(adapterPath, `export default {
      name: "external-sandbox",
      safety: { mode: "sandbox", networkAccess: false, syntheticDataOnly: true, allowedTargetSystems: ["Demo"] },
      createTenant() {}, deleteTenant() {}, resetTenant() {}, seedTenant() {}, hasTenant() { return false; }, snapshotTenant() { return {}; }, adapterForTenant() { return {}; }
    };\n`);
    process.env.AGENTCERT_BASE_URL = "https://agentcert.example.com";
    process.env.AGENTCERT_PROJECT_ID = "project-1";
    process.env.AGENTCERT_API_KEY = "ac_live_test-key";
    const report = {
      schemaVersion: "agentcert.sandbox_adapter_conformance.v0.2",
      kind: "agentcert.sandbox_adapter_conformance" as const,
      implementation: "external-sandbox",
      generatedAt: "2030-01-01T00:00:00.000Z",
      verdict: { passed: true, score: 100 },
      summary: { passed: 4, failed: 0, total: 4 },
      checks: [{ id: "adapter-contract", status: "passed" as const, message: "Contract passed." }],
    };
    const upload = vi.fn().mockResolvedValue({ run: { id: "run-1" }, evidence: { id: "evidence-1" } });
    const runtime = {
      runSandboxAdapterConformanceSuite: vi.fn().mockResolvedValue(report),
      writeSandboxAdapterConformanceReport: vi.fn(async (value: unknown, path: string) => {
        await writeFile(path, `${JSON.stringify(value)}\n`);
        return path;
      }),
      uploadSandboxCertificationReport: upload,
    };

    const result = await pushSandboxCertification([
      "--adapter", adapterPath,
      "--out", reportPath,
      "--external-id", "sandbox-smoke-1",
    ], runtime);

    expect(result.exitCode).toBe(0);
    expect(upload).toHaveBeenCalledWith(report, expect.objectContaining({
      baseUrl: "https://agentcert.example.com",
      projectId: "project-1",
      apiKey: "ac_live_test-key",
      externalId: "sandbox-smoke-1",
    }));
    await expect(readFile(reportPath, "utf8")).resolves.toContain("external-sandbox");
  });

  it("runs the Stripe read-only flow from an environment credential and can upload the redacted report", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const directory = await temporaryDirectory();
    const reportPath = join(directory, "stripe-report.json");
    process.env.STRIPE_RESTRICTED_TEST_KEY = "rk_test_cli_secret_123";
    process.env.AGENTCERT_BASE_URL = "https://agentcert.example.com";
    process.env.AGENTCERT_PROJECT_ID = "project-1";
    process.env.AGENTCERT_API_KEY = "ac_live_test-key";
    const report = {
      schemaVersion: "agentcert.sandbox_vendor_egress.v0.4" as const,
      kind: "agentcert.sandbox_vendor_egress" as const,
      implementation: "stripe-payment-intent-readonly" as const,
      vendor: "stripe" as const,
      environment: "sandbox" as const,
      generatedAt: "2030-01-01T00:00:00.000Z",
      verdict: { passed: true, score: 100 },
      summary: { passed: 5, failed: 0, total: 5 },
      checks: [{ id: "bounded-read", status: "passed" as const, message: "Bounded read passed." }],
      policy: { allowedOrigins: ["https://api.stripe.com"] },
      audit: [{ requestId: "stripe-1", outcome: "allowed" }],
      observation: { id: "pi_12345678", livemode: false },
      disclaimer: "Sandbox only.",
    };
    const upload = vi.fn().mockResolvedValue({ run: { id: "run-stripe" }, evidence: { id: "evidence-stripe" } });
    const run = vi.fn().mockResolvedValue(report);
    const runtime = {
      runSandboxAdapterConformanceSuite,
      writeSandboxAdapterConformanceReport: vi.fn(),
      runStripeSandboxReadOnlyCertification: run,
      uploadSandboxCertificationReport: upload,
    };

    const result = await runStripeSandboxReadOnly([
      "--payment-intent", "pi_12345678",
      "--out", reportPath,
      "--push",
    ], runtime);

    expect(result.exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith({
      restrictedApiKey: "rk_test_cli_secret_123",
      paymentIntentId: "pi_12345678",
    });
    expect(upload).toHaveBeenCalledWith(report, expect.objectContaining({ projectId: "project-1" }));
    const written = await readFile(reportPath, "utf8");
    expect(written).toContain("agentcert.sandbox_vendor_egress.v0.4");
    expect(written).not.toContain("rk_test_cli_secret_123");
  });

  it("refuses Stripe credentials supplied through flags", async () => {
    process.env.STRIPE_RESTRICTED_TEST_KEY = "rk_test_environment_key_123";
    await expect(runStripeSandboxReadOnly([
      "--payment-intent", "pi_12345678",
      "--stripe-key", "rk_test_flag_key_123",
    ])).rejects.toThrow("only through STRIPE_RESTRICTED_TEST_KEY");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcert-sandbox-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
