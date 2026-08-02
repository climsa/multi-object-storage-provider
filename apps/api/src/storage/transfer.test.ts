import { describe, expect, it } from "vitest";

import {
  createProxyTransferConfig,
  DEFAULT_MAX_PROXY_OBJECT_BYTES,
  DEFAULT_PROXY_TRANSFER_TIMEOUT_SECONDS,
} from "./transfer.js";

describe("proxy transfer configuration", () => {
  it("accepts values within the hard safety ceilings", () => {
    const config = createProxyTransferConfig(5n * 1024n * 1024n, 45);

    expect(config).toEqual({ maxObjectBytes: 5n * 1024n * 1024n, timeoutMs: 45_000 });
  });

  it("falls back to secure defaults when a stored value is invalid", () => {
    const config = createProxyTransferConfig(2n * DEFAULT_MAX_PROXY_OBJECT_BYTES, 301);

    expect(config).toEqual({
      maxObjectBytes: DEFAULT_MAX_PROXY_OBJECT_BYTES,
      timeoutMs: DEFAULT_PROXY_TRANSFER_TIMEOUT_SECONDS * 1000,
    });
  });
});
