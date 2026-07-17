import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentCertClient } from "agentcert-sdk";

export function createAgentCertMcpServer(client: AgentCertClient): McpServer {
  const server = new McpServer({ name: "agentcert", version: "0.1.0" });

  server.registerTool(
    "agentcert_start_run",
    {
      description: "Start an AgentCert assurance run before emitting events or evidence.",
      inputSchema: {
        externalId: z.string().min(1),
        agentId: z.string().optional(),
        kind: z.enum(["mcpbench", "tripwire", "release_gate", "runtime", "custom"]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => toolResult(await client.startRun(input)),
  );

  server.registerTool(
    "agentcert_record_events",
    {
      description: "Append a bounded batch of ordered events to an AgentCert run.",
      inputSchema: {
        runId: z.string().min(1),
        events: z.array(z.object({
          sequence: z.number().int().nonnegative(),
          type: z.string().min(1),
          actor: z.string().optional(),
          occurredAt: z.string().optional(),
          payload: z.record(z.string(), z.unknown()).optional(),
        })).min(1).max(500),
      },
    },
    async ({ runId, events }) => toolResult(await client.appendEvents(runId, events)),
  );

  server.registerTool(
    "agentcert_assess_action",
    {
      description: "Ask AgentCert whether a proposed high-risk action is allowed, denied, or requires human approval.",
      inputSchema: {
        externalId: z.string().min(1),
        agentId: z.string().optional(),
        principal: z.record(z.string(), z.unknown()),
        actionType: z.enum(["SUBMIT", "PAY", "SEND", "UPDATE"]),
        targetSystem: z.string().min(1),
        requestedPermissions: z.array(z.string()),
        amount: z.number().nonnegative().optional(),
        currency: z.string().optional(),
        externalRecipient: z.boolean().optional(),
        sensitive: z.boolean().optional(),
        expectedState: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => toolResult(await client.assessAction(input)),
  );

  server.registerTool(
    "agentcert_get_action",
    {
      description: "Read the current policy, approval, and verification state for an AgentCert action.",
      inputSchema: { actionId: z.string().min(1) },
    },
    async ({ actionId }) => toolResult(await client.getAction(actionId)),
  );

  server.registerTool(
    "agentcert_verify_action",
    {
      description: "Submit observed state after an allowed action so AgentCert can verify the real outcome.",
      inputSchema: {
        actionId: z.string().min(1),
        observedState: z.record(z.string(), z.unknown()),
      },
    },
    async ({ actionId, observedState }) => toolResult(await client.verifyAction(actionId, observedState)),
  );

  return server;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
