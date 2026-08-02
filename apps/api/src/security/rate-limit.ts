import { createHash } from "node:crypto";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitDecision | Promise<RateLimitDecision>;
}

/** Raised when the shared limiter cannot make a safe allow/deny decision. */
export class RateLimiterUnavailableError extends Error {
  public constructor() {
    super("RATE_LIMITER_UNAVAILABLE");
    this.name = "RateLimiterUnavailableError";
  }
}

export interface RedisRateLimitStore {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    if (limit < 1 || windowMs < 1 || maxEntries < 1) {
      throw new Error("Rate limiter settings must be positive");
    }
  }

  public consume(key: string): RateLimitDecision {
    const now = this.now();
    const current = this.entries.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : current;

    entry.count += 1;
    this.entries.set(key, entry);
    this.evictExpired(now);

    return {
      allowed: entry.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }

    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort(([, left], [, right]) => left.resetAt - right.resetAt)
      .slice(0, this.entries.size - this.maxEntries);
    for (const [key] of oldest) this.entries.delete(key);
  }
}

/** Atomic fixed-window limiter shared by every API instance using Redis. */
export class RedisRateLimiter implements RateLimiter {
  private static readonly SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    return { count, redis.call('PTTL', KEYS[1]) }
  `;

  public constructor(
    private readonly store: RedisRateLimitStore,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly prefix = "mosp:ratelimit",
  ) {
    if (limit < 1 || windowMs < 1) {
      throw new Error("Rate limiter settings must be positive");
    }
  }

  public async consume(key: string): Promise<RateLimitDecision> {
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    let result: unknown;
    try {
      result = await this.store.eval(RedisRateLimiter.SCRIPT, {
        keys: [`${this.prefix}:${digest}`],
        arguments: [String(this.windowMs)],
      });
    } catch {
      // Never fall back to an allow decision when shared coordination is down.
      throw new RateLimiterUnavailableError();
    }
    if (!Array.isArray(result) || result.length < 2) {
      throw new RateLimiterUnavailableError();
    }

    let count: number;
    let ttlMs: number;
    try {
      count = Number(result[0]);
      ttlMs = Number(result[1]);
    } catch {
      throw new RateLimiterUnavailableError();
    }
    if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
      throw new RateLimiterUnavailableError();
    }

    return {
      allowed: count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, ttlMs) / 1000)),
    };
  }
}

export function rateLimitKey(requestIp: string | undefined, suffix: string): string {
  return `${requestIp ?? "unknown"}:${suffix}`;
}
