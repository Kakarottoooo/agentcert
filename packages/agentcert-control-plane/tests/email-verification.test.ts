import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryArtifactStore } from "../src/artifacts.js";
import { Authenticator } from "../src/auth.js";
import { createControlPlaneHttpServer } from "../src/server.js";
import { AgentCertControlPlane } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";

const servers: ReturnType<typeof createControlPlaneHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("notification verification HTTP flow", () => {
  it("redirects browsers to the branded result while keeping a private JSON contract", async () => {
    const store = new InMemoryControlPlaneStore();
    const token = "verification-token";
    await store.saveNotificationDestination({
      id: "destination-1",
      projectId: "project-1",
      email: "security@example.com",
      alertTypes: ["incident_opened"],
      status: "pending_verification",
      verificationTokenHash: createHash("sha256").update(token).digest("hex"),
      verificationExpiresAt: "2099-01-01T00:00:00.000Z",
      createdBy: "user-1",
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    const origin = await startVerificationServer(store);

    const browserResponse = await fetch(`${origin}/v1/notification-destinations/verify?token=${token}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(browserResponse.status).toBe(303);
    expect(browserResponse.headers.get("location")).toBe("/verify-email?status=verified");

    const jsonResponse = await fetch(`${origin}/v1/notification-destinations/verify?token=${token}`, {
      headers: { accept: "application/json" },
    });
    expect(jsonResponse.status).toBe(200);
    await expect(jsonResponse.json()).resolves.toEqual({ verified: true, outcome: "already_verified" });
  });

  it("redirects expired and invalid browser links to actionable states", async () => {
    const store = new InMemoryControlPlaneStore();
    const expiredToken = "expired-token";
    await store.saveNotificationDestination({
      id: "destination-expired",
      projectId: "project-1",
      email: "expired@example.com",
      alertTypes: ["incident_opened"],
      status: "pending_verification",
      verificationTokenHash: createHash("sha256").update(expiredToken).digest("hex"),
      verificationExpiresAt: "2020-01-01T00:00:00.000Z",
      createdBy: "user-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const origin = await startVerificationServer(store);

    const expired = await fetch(`${origin}/v1/notification-destinations/verify?token=${expiredToken}`, {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    expect(expired.headers.get("location")).toBe("/verify-email?status=expired");
    const invalid = await fetch(`${origin}/v1/notification-destinations/verify?token=unknown`, {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    expect(invalid.headers.get("location")).toBe("/verify-email?status=invalid");
  });
});

async function startVerificationServer(store: InMemoryControlPlaneStore): Promise<string> {
  const service = new AgentCertControlPlane(store, new MemoryArtifactStore());
  const server = createControlPlaneHttpServer({
    service,
    authenticator: new Authenticator({ store, devMode: true }),
    publicConfig: {
      kind: "agentcert.control_plane_config",
      hosted: true,
      publicUrl: "https://agentcert.example",
      auth: { provider: "development", registrationOpen: false },
    },
    host: "127.0.0.1",
    port: 0,
    dashboardDir: process.cwd(),
    maxArtifactBytes: 1024,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
