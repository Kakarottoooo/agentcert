import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { certifyBrowserAdapter, initializeBrowserAdapter } from "../src/browser-adapter.js";

describe("browser-adapter CLI", () => {
  it("writes a dependency-free sandbox-only starter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-browser-adapter-"));
    const adapterPath = join(directory, "adapter.mjs");
    await initializeBrowserAdapter(["--adapter", adapterPath]);
    const source = await readFile(adapterPath, "utf8");
    expect(source).not.toContain('from "agentcert/browser-adapter-kit"');
    expect(source).toContain("export const browserAdapterConfig");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("forbiddenSecrets");
    const generated = await import(pathToFileURL(adapterPath).href);
    expect(generated.browserAdapterConfig).toMatchObject({ sandbox: true });
    expect(generated.browserAdapterFixture).toBeDefined();
  });

  it("writes and renders the conformance result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcert-browser-report-"));
    const reportPath = join(directory, "report.json");
    const runtime = {
      createCustomerOwnedBrowserAdapterKit: vi.fn(() => ({ name: "created", prepareExecution: async () => ({}) })),
      runCustomerOwnedBrowserAdapterConformance: vi.fn(async () => ({
        schemaVersion: "agentcert.customer_browser_adapter_conformance.v0.1" as const,
        kind: "agentcert.customer_browser_adapter_conformance" as const,
        verdict: { passed: true, score: 100 },
        checks: [{ id: "secret-redaction", status: "passed" as const, message: "No credentials exposed." }],
      })),
    };
    const adapter = { browserAdapterKit: { name: "test", prepareExecution: async () => ({}) }, browserAdapterFixture: { action: {}, expectedObservedState: {}, expectedAudit: {} } };
    const result = await certifyBrowserAdapter(["--out", reportPath], runtime, adapter);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({ verdict: { passed: true, score: 100 } });
  });
});
