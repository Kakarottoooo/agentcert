import { createHash, timingSafeEqual } from "node:crypto";
import type { ControlPlaneStore } from "./store.js";
import type { AuthContext } from "./types.js";

export interface AuthenticatorOptions {
  store: ControlPlaneStore;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  devMode?: boolean;
}

export class Authenticator {
  constructor(private readonly options: AuthenticatorOptions) {}

  async authenticate(authorization: string | undefined): Promise<AuthContext | undefined> {
    const token = bearerToken(authorization);
    if (!token) return undefined;
    if (token.startsWith("ac_live_")) return this.authenticateApiKey(token);
    if (this.options.devMode && token === "dev-local-token") {
      return { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "developer@localhost" };
    }
    if (!this.options.supabaseUrl || !this.options.supabaseAnonKey) return undefined;
    const response = await fetch(`${this.options.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: this.options.supabaseAnonKey, authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const user = (await response.json()) as { id?: string; email?: string };
    return user.id ? { kind: "user", userId: user.id, email: user.email } : undefined;
  }

  private async authenticateApiKey(token: string): Promise<AuthContext | undefined> {
    const secretHash = hashSecret(token);
    const apiKey = await this.options.store.findApiKeyByHash(secretHash);
    if (!apiKey || !safeEqual(apiKey.secretHash, secretHash)) return undefined;
    const usedAt = new Date().toISOString();
    await this.options.store.touchApiKey(apiKey.id, usedAt);
    return { kind: "api_key", projectId: apiKey.projectId, apiKeyId: apiKey.id };
  }
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
