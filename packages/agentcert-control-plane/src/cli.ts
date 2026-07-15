#!/usr/bin/env node
import { resolve } from "node:path";
import { LocalArtifactStore, MemoryArtifactStore, SupabaseArtifactStore } from "./artifacts.js";
import { Authenticator } from "./auth.js";
import { startControlPlaneServer } from "./server.js";
import { AgentCertControlPlane } from "./service.js";
import { InMemoryControlPlaneStore, PostgresControlPlaneStore } from "./store.js";
import type { PublicConfig } from "./types.js";

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
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (production && (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey)) {
  throw new Error("Production requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.");
}

const artifacts = supabaseUrl && supabaseServiceRoleKey
  ? new SupabaseArtifactStore(supabaseUrl, supabaseServiceRoleKey, process.env.AGENTCERT_STORAGE_BUCKET ?? "agentcert-evidence")
  : devMode
    ? new LocalArtifactStore(resolve(".agentcert/control-plane/artifacts"))
    : new MemoryArtifactStore();
const service = new AgentCertControlPlane(store, artifacts);
const authenticator = new Authenticator({ store, supabaseUrl, supabaseAnonKey, devMode });
const publicConfig: PublicConfig = {
  kind: "agentcert.control_plane_config",
  hosted: true,
  publicUrl: process.env.AGENTCERT_PUBLIC_URL ?? `http://${host}:${port}`,
  auth: {
    provider: devMode ? "development" : "supabase",
    supabaseUrl: devMode ? undefined : supabaseUrl,
    supabaseAnonKey: devMode ? undefined : supabaseAnonKey,
    registrationOpen: true,
  },
};

await startControlPlaneServer({
  service,
  authenticator,
  publicConfig,
  host,
  port,
  dashboardDir: process.env.AGENTCERT_DASHBOARD_DIR ?? resolve("public-demo/agentcert-monitor"),
  maxArtifactBytes: integerEnv("AGENTCERT_MAX_ARTIFACT_BYTES", 20 * 1024 * 1024),
});

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
