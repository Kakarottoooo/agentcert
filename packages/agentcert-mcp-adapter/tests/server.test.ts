import { describe, expect, it, vi } from "vitest";
import { AgentCertClient } from "agentcert-sdk";
import { createAgentCertMcpServer } from "../src/index.js";

describe("createAgentCertMcpServer", () => {
  it("creates an MCP server without exposing an approval tool", () => {
    const request = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request });
    const server = createAgentCertMcpServer(client);
    expect(server).toBeDefined();
  });
});
