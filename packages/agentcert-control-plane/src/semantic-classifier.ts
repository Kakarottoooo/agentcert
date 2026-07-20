import type { CapabilitySuggestionProvider } from "./semantics.js";

export interface OpenAICompatibleClassifierOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAICompatibleCapabilityClassifier implements CapabilitySuggestionProvider {
  readonly provider = "openai-compatible";
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(private readonly options: OpenAICompatibleClassifierOptions) {
    if (!options.apiKey.trim() || !options.model.trim()) throw new Error("Semantic classifier apiKey and model are required.");
    this.model = options.model.trim();
    this.endpoint = options.endpoint?.trim() || "https://api.openai.com/v1/chat/completions";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.request = options.fetch ?? fetch;
  }

  async suggest(input: Parameters<CapabilitySuggestionProvider["suggest"]>[0]) {
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Classify one redacted agent tool observation. Choose exactly one candidate capability ID. Return JSON with capabilityId, confidence from 0 to 1, and a short rationale. This is advisory and must not infer authorization or evidence strength.",
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Semantic classifier request failed with status ${response.status}.`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return undefined;
    const value = JSON.parse(content) as Record<string, unknown>;
    if (typeof value.capabilityId !== "string" || typeof value.confidence !== "number" || typeof value.rationale !== "string") return undefined;
    return { capabilityId: value.capabilityId, confidence: value.confidence, rationale: value.rationale.slice(0, 1_000) };
  }
}
