#!/usr/bin/env node
import { runCollectorGatewayConformance } from "./gateway-conformance.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`AgentCert collector gateway conformance suite

Environment:
  AGENTCERT_GATEWAY_URL      Gateway URL (default: http://127.0.0.1:8787)
  AGENTCERT_GATEWAY_TOKEN    Required local bearer token
`);
  process.exit(0);
}

const baseUrl = process.env.AGENTCERT_GATEWAY_URL ?? "http://127.0.0.1:8787";
const gatewayToken = process.env.AGENTCERT_GATEWAY_TOKEN;
if (!gatewayToken) throw new Error("AGENTCERT_GATEWAY_TOKEN is required.");
const report = await runCollectorGatewayConformance({ baseUrl, gatewayToken });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
