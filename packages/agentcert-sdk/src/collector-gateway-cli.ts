#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { CustomerSourceKeyRing, RemoteCollectorClient } from "./remote-collector.js";
import { startCustomerOwnedCollectorGateway } from "./collector-gateway.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`AgentCert customer-owned collector gateway

Required environment:
  AGENTCERT_PROJECT_ID       Hosted project UUID
  AGENTCERT_API_KEY          Scoped key with runs:read, events:write, collector:manage
  AGENTCERT_GATEWAY_TOKEN    Local bearer token used by agent processes

Optional environment:
  AGENTCERT_BASE_URL         Hosted control plane (default: https://agentcert.app)
  AGENTCERT_COLLECTOR_ID     Stable customer collector ID
  AGENTCERT_SOURCE_KEYRING_PATH  Customer-owned Ed25519 key ring path
  AGENTCERT_COLLECTOR_QUEUE_DIR  Durable offline journal directory
  HOST / PORT                Listen address (default: 0.0.0.0:8787)
`);
  process.exit(0);
}

const baseUrl = process.env.AGENTCERT_BASE_URL ?? "https://agentcert.app";
const projectId = requiredEnv("AGENTCERT_PROJECT_ID");
const apiKey = requiredEnv("AGENTCERT_API_KEY");
const gatewayToken = requiredEnv("AGENTCERT_GATEWAY_TOKEN");
const collectorId = process.env.AGENTCERT_COLLECTOR_ID ?? "customer-owned-gateway";
const keyRingPath = resolve(process.env.AGENTCERT_SOURCE_KEYRING_PATH ?? "/var/lib/agentcert/source-keys.json");
const storageDirectory = resolve(process.env.AGENTCERT_COLLECTOR_QUEUE_DIR ?? "/var/lib/agentcert/queue");
const keyRing = await (await exists(keyRingPath)
  ? CustomerSourceKeyRing.open(keyRingPath)
  : CustomerSourceKeyRing.create(keyRingPath, collectorId));
const client = new RemoteCollectorClient({ baseUrl, projectId, apiKey });
const gateway = await startCustomerOwnedCollectorGateway({
  client,
  keyRing,
  gatewayToken,
  storageDirectory,
  host: process.env.HOST ?? "0.0.0.0",
  port: numberEnv("PORT", 8787),
  environment: process.env.AGENTCERT_ENVIRONMENT ?? "customer-owned",
});

process.stdout.write(`AgentCert customer-owned collector gateway listening on ${gateway.baseUrl}\n`);
process.stdout.write(`Collector ${keyRing.collectorId}; source key ${keyRing.activeSigner().keyId}; queue ${storageDirectory}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void gateway.close().finally(() => process.exit(0)));

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; }
function numberEnv(name: string, fallback: number): number { const value = process.env[name]; if (!value) return fallback; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${name} must be a valid TCP port.`); return parsed; }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
