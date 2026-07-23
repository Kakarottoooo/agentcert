import { describe, expect, it, vi } from "vitest";
import type { AgentCertClient } from "agentcert-sdk";
import { AgentCertMcpToolRecorder } from "../src/index.js";

describe("AgentCertMcpToolRecorder", () => {
  it("wraps MCP calls with ordered semantic events", async () => {
    const appendEvents = vi.fn(async () => ({ events: [] }));
    const recorder = new AgentCertMcpToolRecorder({ appendEvents } as unknown as AgentCertClient, { runId: "run-1", nextSequence: 4 });

    await expect(recorder.call({
      serverName: "filesystem", toolName: "read_file", arguments: { path: "README.md" },
      capability: { schemaVersion: "agentcert.capability_manifest.v0.1", id: "coding.read" },
      invoke: async () => ({ text: "ok" }),
    })).resolves.toEqual({ text: "ok" });

    expect(appendEvents).toHaveBeenCalledTimes(2);
    expect(appendEvents.mock.calls.map((call) => call[1][0].sequence)).toEqual([4, 5]);
    expect(appendEvents.mock.calls.map((call) => call[1][0].payload.semantic.phase)).toEqual(["started", "completed"]);
  });
});
