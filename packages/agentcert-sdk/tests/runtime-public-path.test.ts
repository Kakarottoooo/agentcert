import { describe, expect, it } from "vitest";

describe("agentcert-sdk/runtime public subpath", () => {
  it("ships the controlled runtime from the existing AgentCert SDK", async () => {
    const runtime = await import("../dist/runtime/index.js");
    expect(runtime.createAgentCertRuntime).toBeTypeOf("function");
    expect(runtime.createAgentCertTrustedActionRuntime).toBeTypeOf("function");
    expect(runtime.createOnegentRuntime).toBeTypeOf("function");
    expect(runtime.createTrustedActionRuntime).toBeTypeOf("function");
    expect(runtime.TrustedActionRecorder).toBeTypeOf("function");
    expect(runtime.createControlledActionAdapter).toBeTypeOf("function");
    expect(runtime.createIndependentOutcomeProbe).toBeTypeOf("function");
  });
});
