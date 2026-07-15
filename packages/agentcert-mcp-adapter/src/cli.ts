#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentCertClient } from "@agentcert/sdk";
import { createAgentCertMcpServer } from "./index.js";

const baseUrl = requiredEnv("AGENTCERT_BASE_URL");
const projectId = requiredEnv("AGENTCERT_PROJECT_ID");
const apiKey = requiredEnv("AGENTCERT_API_KEY");
const server = createAgentCertMcpServer(new AgentCertClient({ baseUrl, projectId, apiKey }));
await server.connect(new StdioServerTransport());

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
