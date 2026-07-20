import { describe, expect, it, vi } from "vitest";
import { instrumentTool, type AgentCertRunRecorder, type InstrumentedCapability } from "../src/index.js";

const capability: InstrumentedCapability = {
  schemaVersion: "agentcert.capability_manifest.v0.1", id: "messaging.send", version: "0.1.0", name: "Send message",
  domain: "messaging", operations: ["send"], sideEffect: "external", resourceTypes: ["message"],
  requiredPermissions: ["messages:send"], risk: "high", idempotency: "required", reversibility: "irreversible",
  enforcement: "gateway", verification: "independent_probe",
};

describe("instrumentTool", () => {
  it("records one semantic invocation without retaining secret values", async () => {
    const recordEvent = vi.fn(async (value) => value);
    const recorder = { childTrace: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }), recordEvent } as unknown as AgentCertRunRecorder;
    const wrapped = instrumentTool({ recorder, capability, toolName: "send_email", execute: async (input: { to: string; apiKey: string }) => ({ id: "message-1", to: input.to }) });

    await expect(wrapped({ to: "reviewer@example.com", apiKey: "never-store-this" })).resolves.toMatchObject({ id: "message-1" });

    expect(recordEvent).toHaveBeenCalledTimes(2);
    const events = recordEvent.mock.calls.map(([value]) => value);
    expect(events.map((value) => value.payload.semantic.phase)).toEqual(["started", "completed"]);
    expect(events[0].payload.semantic.invocationId).toBe(events[1].payload.semantic.invocationId);
    expect(JSON.stringify(events)).not.toContain("never-store-this");
  });
});
