import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";

import { PlatformService } from "./service.js";

describe("PlatformService runtime settings", () => {
  it("reads bigint settings without converting through number", async () => {
    const database = {
      platformSetting: {
        findUnique: vi.fn().mockResolvedValue({ value: "1073741824" }),
      },
    } as unknown as PrismaClient;

    await expect(
      new PlatformService(database).getBigIntSetting("proxy_max_object_size_bytes", 1n),
    ).resolves.toBe(1_073_741_824n);
  });

  it("falls back when a stored bigint setting is malformed", async () => {
    const database = {
      platformSetting: {
        findUnique: vi.fn().mockResolvedValue({ value: 1073741824 }),
      },
    } as unknown as PrismaClient;

    await expect(
      new PlatformService(database).getBigIntSetting("proxy_max_object_size_bytes", 42n),
    ).resolves.toBe(42n);
  });
});
