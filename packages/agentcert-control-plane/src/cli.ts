#!/usr/bin/env node
import { resolve } from "node:path";
import { LocalArtifactStore, MemoryArtifactStore, SupabaseArtifactStore } from "./artifacts.js";
import { Authenticator } from "./auth.js";
import { startControlPlaneServer } from "./server.js";
import { AgentCertControlPlane } from "./service.js";
import { InMemoryControlPlaneStore, PostgresControlPlaneStore } from "./store.js";
import type { EvidenceGovernancePolicy } from "./evidence-governance.js";
import type { PublicConfig } from "./types.js";
import { EvidenceSigner } from "./signing.js";
import { FixedWindowRateLimiter, WebhookSecretVault } from "./security.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = integerEnv("PORT", 8787);
const devMode = process.env.AGENTCERT_DEV_MODE === "true";
const production = process.env.NODE_ENV === "production";
if (production && devMode) throw new Error("AGENTCERT_DEV_MODE cannot be enabled in production.");
if (devMode && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  throw new Error("AGENTCERT_DEV_MODE may only listen on a loopback host.");
}

const databaseUrl = process.env.DATABASE_URL;
if (production && !databaseUrl) throw new Error("Production requires DATABASE_URL.");
const store = databaseUrl ? new PostgresControlPlaneStore(databaseUrl) : new InMemoryControlPlaneStore();
await store.migrate();

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (production && (!supabaseUrl || !supabasePublishableKey || !supabaseSecretKey)) {
  throw new Error("Production requires SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY (legacy key variable names are also accepted).");
}

const artifacts = supabaseUrl && supabaseSecretKey
  ? new SupabaseArtifactStore(supabaseUrl, supabaseSecretKey, process.env.AGENTCERT_STORAGE_BUCKET ?? "agentcert-evidence")
  : devMode
    ? new LocalArtifactStore(resolve(".agentcert/control-plane/artifacts"))
    : new MemoryArtifactStore();
const evidencePolicy: EvidenceGovernancePolicy = {
  projectLimitBytes: integerEnv("AGENTCERT_PROJECT_STORAGE_BYTES", 1024 * 1024 * 1024),
  runLimitBytes: integerEnv("AGENTCERT_RUN_STORAGE_BYTES", 100 * 1024 * 1024),
  retentionDays: integerEnv("AGENTCERT_EVIDENCE_RETENTION_DAYS", 90),
};
const platformAdminEmails = (process.env.AGENTCERT_PLATFORM_ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const signingPrivateKey = secretTextEnv("AGENTCERT_EVIDENCE_SIGNING_PRIVATE_KEY");
const evidenceSigner = signingPrivateKey
  ? new EvidenceSigner(process.env.AGENTCERT_EVIDENCE_SIGNING_KEY_ID ?? "agentcert-server-v0.1", signingPrivateKey)
  : undefined;
const webhookEncryptionKey = process.env.AGENTCERT_WEBHOOK_ENCRYPTION_KEY;
const webhookVault = webhookEncryptionKey ? new WebhookSecretVault(webhookEncryptionKey) : undefined;
const service = new AgentCertControlPlane(store, artifacts, evidencePolicy, platformAdminEmails, evidenceSigner, webhookVault);
const authenticator = new Authenticator({ store, supabaseUrl, supabasePublishableKey, devMode });
const publicConfig: PublicConfig = {
  kind: "agentcert.control_plane_config",
  hosted: true,
  publicUrl: process.env.AGENTCERT_PUBLIC_URL ?? `http://${host}:${port}`,
  auth: {
    provider: devMode ? "development" : "supabase",
    supabaseUrl: devMode ? undefined : supabaseUrl,
    supabasePublishableKey: devMode ? undefined : supabasePublishableKey,
    registrationOpen: true,
  },
};

if (process.argv[2] === "cleanup-evidence") {
  const result = await service.cleanupExpiredEvidence(new Date(), integerEnv("AGENTCERT_EVIDENCE_CLEANUP_BATCH", 500));
  process.stdout.write(`${JSON.stringify({ event: "evidence_retention_cleanup", ...result })}\n`);
  await store.close();
} else {
  await startControlPlaneServer({
    service,
    authenticator,
    publicConfig,
    host,
    port,
    dashboardDir: process.env.AGENTCERT_DASHBOARD_DIR ?? resolve("public-demo/agentcert-monitor"),
    maxArtifactBytes: integerEnv("AGENTCERT_MAX_ARTIFACT_BYTES", 20 * 1024 * 1024),
    rateLimiter: new FixedWindowRateLimiter(
      integerEnv("AGENTCERT_RATE_LIMIT_REQUESTS", 300),
      integerEnv("AGENTCERT_RATE_LIMIT_WINDOW_MS", 60_000),
    ),
  });
  scheduleEvidenceCleanup(
    service,
    integerEnv("AGENTCERT_EVIDENCE_CLEANUP_INTERVAL_MS", 24 * 60 * 60 * 1000),
    integerEnv("AGENTCERT_EVIDENCE_CLEANUP_BATCH", 500),
  );
}

function scheduleEvidenceCleanup(service: AgentCertControlPlane, intervalMs: number, batchSize: number): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await service.cleanupExpiredEvidence(new Date(), batchSize);
      process.stdout.write(`${JSON.stringify({ event: "evidence_retention_cleanup", ...result })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ event: "evidence_retention_cleanup_failed", message: error instanceof Error ? error.message : String(error) })}\n`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void run(), 1_000).unref();
  setInterval(() => void run(), intervalMs).unref();
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function secretTextEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (raw.includes("BEGIN PRIVATE KEY")) return raw.replace(/\\n/g, "\n");
  try { return Buffer.from(raw, "base64").toString("utf8"); }
  catch { throw new Error(`${name} must be PEM text or base64-encoded PEM.`); }
}
