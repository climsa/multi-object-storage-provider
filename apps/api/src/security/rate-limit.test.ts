import { describe, expect, it } from "vitest";

import { InMemoryRateLimiter, RateLimiterUnavailableError, RedisRateLimiter } from "./rate-limit.js";

describe("InMemoryRateLimiter", () => {
  it("limits requests within a window and resets afterward", () => {
    let now = 1_000;
    const limiter = new InMemoryRateLimiter(2, 1_000, 10, () => now);

    expect(limiter.consume("client").allowed).toBe(true);
    expect(limiter.consume("client").allowed).toBe(true);
    expect(limiter.consume("client").allowed).toBe(false);

    now = 2_001;
    expect(limiter.consume("client").allowed).toBe(true);
  });
});

describe("RedisRateLimiter", () => {
  it("uses the atomic Redis result to enforce a shared window", async () => {
    const store = {
      eval: async () => [3, 42_000],
    };
    const limiter = new RedisRateLimiter(store, 2, 60_000);

    await expect(limiter.consume("client")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 42,
    });
    expect(store).toBeDefined();
  });

  it("fails closed when Redis is unavailable or returns malformed data", async () => {
    const unavailable = new RedisRateLimiter({
      eval: async () => { throw new Error("redis://secret must not escape"); },
    }, 2, 60_000);
    const malformed = new RedisRateLimiter({ eval: async () => ["not-a-count", 42_000] }, 2, 60_000);

    await expect(unavailable.consume("client")).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(malformed.consume("client")).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
});
