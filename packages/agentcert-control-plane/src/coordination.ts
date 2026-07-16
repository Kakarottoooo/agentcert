import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { RateLimiter, RateLimitResult } from "./security.js";

type RedisClient = ReturnType<typeof createClient>;

export interface IdempotencyCoordinator {
  readonly backend: "memory" | "redis";
  runExclusive<T>(key: string, execute: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
}

export interface CoordinationHealth {
  backend: "memory" | "redis";
  state: "ready" | "degraded";
  shared: boolean;
}

export class LocalIdempotencyCoordinator implements IdempotencyCoordinator {
  readonly backend = "memory" as const;
  private readonly locks = new Set<string>();

  async runExclusive<T>(key: string, execute: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
    if (this.locks.has(key)) return { acquired: false };
    this.locks.add(key);
    try { return { acquired: true, value: await execute() }; }
    finally { this.locks.delete(key); }
  }
}

export class RedisFixedWindowRateLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisClient,
    readonly limit: number,
    readonly windowMs: number,
    private readonly prefix = "agentcert:rate",
  ) {
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error("Rate limit and window must be positive integers.");
    }
  }

  async consume(key: string, now = Date.now()): Promise<RateLimitResult> {
    const bucket = Math.floor(now / this.windowMs);
    const redisKey = `${this.prefix}:${bucket}:${key}`;
    const raw = await this.client.eval(
      "local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('PTTL',KEYS[1]); return {count,ttl}",
      { keys: [redisKey], arguments: [String(this.windowMs)] },
    ) as [number, number];
    const count = Number(raw[0]);
    const ttl = Math.max(1, Number(raw[1]));
    const resetAt = now + ttl;
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }
}

export class RedisIdempotencyCoordinator implements IdempotencyCoordinator {
  readonly backend = "redis" as const;

  constructor(
    private readonly client: RedisClient,
    private readonly leaseMs = 30_000,
    private readonly prefix = "agentcert:idempotency",
  ) {}

  async runExclusive<T>(key: string, execute: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
    const lockKey = `${this.prefix}:${key}`;
    const token = randomUUID();
    const acquired = await this.client.set(lockKey, token, { NX: true, PX: this.leaseMs });
    if (acquired !== "OK") return { acquired: false };
    try { return { acquired: true, value: await execute() }; }
    finally {
      await this.client.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        { keys: [lockKey], arguments: [token] },
      ).catch(() => undefined);
    }
  }
}

export interface CoordinationRuntime {
  rateLimiter: RateLimiter;
  idempotency: IdempotencyCoordinator;
  health(): CoordinationHealth;
  close(): Promise<void>;
}

export async function createRedisCoordination(
  url: string,
  limit: number,
  windowMs: number,
  onError: (error: Error) => void = () => undefined,
): Promise<CoordinationRuntime> {
  const client = createClient({ url });
  client.on("error", onError);
  await client.connect();
  return {
    rateLimiter: new RedisFixedWindowRateLimiter(client, limit, windowMs),
    idempotency: new RedisIdempotencyCoordinator(client),
    health: () => ({ backend: "redis", state: client.isReady ? "ready" : "degraded", shared: true }),
    close: async () => { if (client.isOpen) await client.close(); },
  };
}
