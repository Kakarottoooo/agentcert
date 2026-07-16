import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiKeyScope, WebhookDeliveryRecord, WebhookRecord } from "./types.js";

export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "agents:read",
  "runs:read",
  "runs:write",
  "events:write",
  "actions:read",
  "actions:write",
  "evidence:read",
  "evidence:write",
];

export const API_KEY_SCOPES = new Set<ApiKeyScope>(DEFAULT_API_KEY_SCOPES);

export function parseApiKeyScopes(value: unknown): ApiKeyScope[] {
  if (value === undefined) return [...DEFAULT_API_KEY_SCOPES];
  if (!Array.isArray(value) || value.length === 0) throw new Error("scopes must contain at least one API key scope.");
  const scopes = [...new Set(value.map(String))];
  for (const scope of scopes) if (!API_KEY_SCOPES.has(scope as ApiKeyScope)) throw new Error(`Unsupported API key scope: ${scope}.`);
  return scopes as ApiKeyScope[];
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly limit: number, readonly windowMs: number) {
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error("Rate limit and window must be positive integers.");
    }
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    const allowed = window.count <= this.limit;
    if (this.windows.size > 10_000) this.prune(now);
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - window.count),
      resetAt: window.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

export function rateLimitIdentity(request: IncomingMessage, principal?: string): string {
  if (principal) return `principal:${principal}`;
  const forwarded = request.headers["x-forwarded-for"]?.toString().split(",", 1)[0]?.trim();
  return `ip:${forwarded || request.socket.remoteAddress || "unknown"}`;
}

export function setRateLimitHeaders(response: ServerResponse, result: RateLimitResult): void {
  response.setHeader("ratelimit-limit", String(result.limit));
  response.setHeader("ratelimit-remaining", String(result.remaining));
  response.setHeader("ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) response.setHeader("retry-after", String(result.retryAfterSeconds));
}

export class WebhookSecretVault {
  private readonly key: Buffer;

  constructor(secret: string) {
    const decoded = decodeEncryptionKey(secret);
    if (decoded.length !== 32) throw new Error("Webhook encryption key must decode to 32 bytes.");
    this.key = decoded;
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(value: string): string {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Webhook secret ciphertext is invalid.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}

export interface WebhookEvent {
  id: string;
  type: string;
  occurredAt: string;
  projectId: string;
  data: unknown;
}

export function createWebhookSignature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function deliverWebhook(
  webhook: WebhookRecord,
  event: WebhookEvent,
  vault: WebhookSecretVault,
  requestFetch: typeof fetch = fetch,
): Promise<WebhookDeliveryRecord> {
  const attemptedAt = new Date().toISOString();
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.parse(attemptedAt) / 1000));
  try {
    const response = await requestFetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "AgentCert-Webhooks/0.1",
        "x-agentcert-event": event.type,
        "x-agentcert-event-id": event.id,
        "x-agentcert-timestamp": timestamp,
        "x-agentcert-signature": createWebhookSignature(vault.decrypt(webhook.secretCiphertext), timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      id: randomUUID(), projectId: webhook.projectId, webhookId: webhook.id, eventId: event.id, eventType: event.type,
      status: response.ok ? "delivered" : "failed", responseStatus: response.status, attemptedAt,
      error: response.ok ? undefined : `Webhook endpoint returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      id: randomUUID(), projectId: webhook.projectId, webhookId: webhook.id, eventId: event.id, eventType: event.type,
      status: "failed", attemptedAt, error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function requestHash(operation: string, body: unknown): string {
  return createHash("sha256").update(operation).update("\0").update(JSON.stringify(body)).digest("hex");
}

function decodeEncryptionKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  return Buffer.from(value, "base64url");
}
