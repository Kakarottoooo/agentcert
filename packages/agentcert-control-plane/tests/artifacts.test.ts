import { describe, expect, it, vi } from "vitest";
import { SupabaseArtifactStore } from "../src/artifacts.js";

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
});

function successfulRequest() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}
