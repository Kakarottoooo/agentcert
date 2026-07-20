import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleCapabilityClassifier } from "../src/semantic-classifier.js";

describe("OpenAICompatibleCapabilityClassifier", () => {
  it("returns a deterministic advisory suggestion from a compatible JSON response", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        capabilityId: "messaging.send",
        confidence: 0.91,
        rationale: "The observed tool sends a message to an external recipient.",
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const classifier = new OpenAICompatibleCapabilityClassifier({
      apiKey: "test-only",
      model: "classifier-test",
      fetch: request as typeof fetch,
    });

    const suggestion = await classifier.suggest({
      observedName: "deliver_note",
      eventType: "agentcert.tool.completed",
      redactedSample: { recipient: "hashed", apiKey: "[REDACTED]" },
      candidates: [{ id: "messaging.send", name: "Send message", domain: "messaging", operations: ["send"], sideEffect: "external" }],
    });

    expect(suggestion).toEqual({
      capabilityId: "messaging.send",
      confidence: 0.91,
      rationale: "The observed tool sends a message to an external recipient.",
    });
    const [, init] = request.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-only" });
    expect(String(init?.body)).toContain("[REDACTED]");
  });

  it("fails closed when the provider returns an HTTP error", async () => {
    const classifier = new OpenAICompatibleCapabilityClassifier({
      apiKey: "test-only",
      model: "classifier-test",
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });

    await expect(classifier.suggest({
      observedName: "unknown",
      eventType: "tool.completed",
      redactedSample: {},
      candidates: [],
    })).rejects.toThrow("status 503");
  });
});
