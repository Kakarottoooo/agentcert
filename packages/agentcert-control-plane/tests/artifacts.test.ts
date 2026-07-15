import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalArtifactStore, MemoryArtifactStore, SupabaseArtifactStore } from "../src/artifacts.js";

describe("SupabaseArtifactStore", () => {
  it("uses a new secret key only as the apikey header", async () => {
    const request = successfulRequest();
    const store = new SupabaseArtifactStore(
      "https://example.supabase.co",
      "sb_secret_test",
      "agentcert-evidence",
      request as unknown as typeof fetch,
    );

    await store.put("runs/run-1/evidence.json", Buffer.from("{}"), "application/json");

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      apikey: "sb_secret_test",
      "content-type": "application/json",
    });
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("keeps the bearer header required by legacy service-role JWTs", async () => {
    const request = successfulRequest();
    const store = new SupabaseArtifactStore(
      "https://example.supabase.co",
      "legacy-service-role-jwt",
      "agentcert-evidence",
      request as unknown as typeof fetch,
    );

    await store.get("runs/run-1/evidence.json");

    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      apikey: "legacy-service-role-jwt",
      authorization: "Bearer legacy-service-role-jwt",
    });
  });

  it("deletes Supabase objects through the storage API", async () => {
    const request = successfulRequest();
    const store = new SupabaseArtifactStore(
      "https://example.supabase.co", "sb_secret_test", "agentcert-evidence",
      request as unknown as typeof fetch,
    );

    await store.delete("project/evidence/run/file.json");

    expect(request).toHaveBeenCalledWith(
      "https://example.supabase.co/storage/v1/object/agentcert-evidence",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ prefixes: ["project/evidence/run/file.json"] }),
      }),
    );
  });

  it("deletes memory and local artifacts idempotently", async () => {
    const memory = new MemoryArtifactStore();
    await memory.put("run/evidence.json", Buffer.from("{}"), "application/json");
    await memory.delete("run/evidence.json");
    await memory.delete("run/evidence.json");
    expect(await memory.get("run/evidence.json")).toBeUndefined();

    const root = await mkdtemp(join(tmpdir(), "agentcert-artifacts-"));
    const local = new LocalArtifactStore(root);
    await local.put("run/evidence.json", Buffer.from("{}"), "application/json");
    expect((await readFile(join(root, "run", "evidence.json"))).toString()).toBe("{}");
    await local.delete("run/evidence.json");
    await local.delete("run/evidence.json");
    expect(await local.get("run/evidence.json")).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });
});

function successfulRequest() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}
