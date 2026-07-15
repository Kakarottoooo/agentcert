import { describe, expect, it, vi } from "vitest";
import { AgentCertClient } from "../src/index.js";

describe("AgentCertClient", () => {
  it("uses project-scoped authenticated endpoints", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "run-1", status: "running" }), { status: 201, headers: { "content-type": "application/json" } }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example/", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });

    const result = await client.startRun({ externalId: "ci-1", kind: "tripwire" });

    expect(result.id).toBe("run-1");
    expect(request).toHaveBeenCalledWith(
      "https://agentcert.example/v1/projects/project-1/runs",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer ac_live_test" }) }),
    );
  });

  it("surfaces API errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: "Project access denied." }), { status: 403 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "bad", fetch: request as typeof fetch });
    await expect(client.getAction("action-1")).rejects.toThrow("Project access denied.");
  });
});
