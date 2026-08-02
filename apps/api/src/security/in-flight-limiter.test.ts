import { describe, expect, it } from "vitest";

import { BoundedInFlightLimiter } from "./in-flight-limiter.js";

describe("BoundedInFlightLimiter", () => {
  it("rejects above the configured concurrency and releases exactly once", () => {
    const limiter = new BoundedInFlightLimiter(1);
    const release = limiter.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(limiter.activeCount).toBe(1);
    expect(limiter.tryAcquire()).toBeNull();

    release?.();
    release?.();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.tryAcquire()).toBeTypeOf("function");
  });

  it("rejects invalid limits", () => {
    expect(() => new BoundedInFlightLimiter(0)).toThrow();
    expect(() => new BoundedInFlightLimiter(1.5)).toThrow();
  });
});
