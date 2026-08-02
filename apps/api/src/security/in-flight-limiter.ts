export interface InFlightLimiter {
  tryAcquire(): (() => void) | null;
  readonly activeCount?: number;
}

/**
 * Bounds work that can hold provider/database resources at the gateway.
 * Saturated requests are rejected instead of accumulating an unbounded queue.
 */
export class BoundedInFlightLimiter implements InFlightLimiter {
  private inFlight = 0;

  public constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("In-flight limiter limit must be a positive integer");
    }
  }

  public tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.limit) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }

  public get activeCount(): number {
    return this.inFlight;
  }
}
