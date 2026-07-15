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

  it("sends the manifest source path for companion evidence reconciliation", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ id: "evidence-1" }), { status: 201 }));
    const client = new AgentCertClient({ baseUrl: "https://agentcert.example", projectId: "project-1", apiKey: "ac_live_test", fetch: request as typeof fetch });
    await client.uploadEvidence({
      bytes: Buffer.from("{}"), fileName: "trace.json", contentType: "application/json", kind: "trace",
      runId: "run-1", sourcePath: "traces/trace.json",
    });
    expect(String(request.mock.calls[0]?.[0])).toContain("sourcePath=traces%2Ftrace.json");
  });
});
