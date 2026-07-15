import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadConnection,
  resolveConnection,
  saveConnection,
  type HostedConnection,
} from "../src/credentials.js";

const connection: HostedConnection = {
  server: "https://agentcert.example.com",
  projectId: "project-1",
  apiKey: "ac_live_secret",
};

describe("hosted connection credentials", () => {
  it("stores named connections outside the repository and loads the default", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "agentcert-credentials-"));
    const path = await saveConnection("pilot", connection, { configHome });

    expect(path).toBe(join(configHome, "credentials.json"));
    expect(await loadConnection(undefined, { configHome })).toEqual(connection);
    expect(await loadConnection("pilot", { configHome })).toEqual(connection);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: "agentcert.credentials.v1",
      defaultConnection: "pilot",
      connections: { pilot: connection },
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("resolves flags before environment variables and stored credentials", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "agentcert-credentials-"));
    await saveConnection("default", connection, { configHome });

    await expect(resolveConnection({
      name: "default",
      server: "https://flag.example.com/",
      env: {
        AGENTCERT_BASE_URL: "https://env.example.com",
        AGENTCERT_PROJECT_ID: "env-project",
        AGENTCERT_API_KEY: "ac_live_env",
      },
      configHome,
    })).resolves.toEqual({
      server: "https://flag.example.com",
      projectId: "env-project",
      apiKey: "ac_live_env",
    });
  });

  it("rejects remote plaintext endpoints before a secret can be sent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "agentcert-credentials-"));
    await expect(saveConnection("unsafe", {
      ...connection,
      server: "http://agentcert.example.com",
    }, { configHome })).rejects.toThrow("HTTPS");

    await expect(saveConnection("local", {
      ...connection,
      server: "http://127.0.0.1:8787",
    }, { configHome })).resolves.toBe(join(configHome, "credentials.json"));
  });

  it("reports missing connection fields with an actionable command", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "agentcert-credentials-"));
    await expect(resolveConnection({ env: {}, configHome })).rejects.toThrow("agentcert connect");
  });
});
