import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";

import { PlacementService } from "./placement-service.js";

const targetA = {
  id: "10000000-0000-4000-8000-000000000001",
  priorityTier: 0,
  weight: 1,
  configuredCapacityBytes: 1000n,
  thresholdPercent: 80,
  bucketConnection: {
    id: "10000000-0000-4000-8000-000000000011",
    bucketName: "primary",
    providerConnectionId: "10000000-0000-4000-8000-000000000021",
  },
};

const targetB = {
  id: "10000000-0000-4000-8000-000000000002",
  priorityTier: 1,
  weight: 100,
  configuredCapacityBytes: null,
  thresholdPercent: 100,
  bucketConnection: {
    id: "10000000-0000-4000-8000-000000000012",
    bucketName: "fallback",
    providerConnectionId: "10000000-0000-4000-8000-000000000022",
  },
};

function createService(candidates: unknown[], usedBytes = 0n, randomPick = 0) {
  const database = {
    placementTarget: { findMany: vi.fn().mockResolvedValue(candidates) },
    $queryRaw: vi.fn().mockResolvedValue([{ usedBytes }]),
  } as unknown as PrismaClient;
  return {
    database,
    service: new PlacementService(database, () => randomPick),
  };
}

describe("PlacementService", () => {
  it("uses a healthy lowest priority tier and weighted choice", async () => {
    const { database, service } = createService([targetA, targetB]);
    const selected = await service.selectTarget("org", "namespace", 10n);

    expect(selected).toEqual({ id: targetA.id, bucketConnection: targetA.bucketConnection });
    expect(database.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("skips a target that would cross its threshold", async () => {
    const { service } = createService([targetA, targetB], 800n);
    const selected = await service.selectTarget("org", "namespace", 1n);

    expect(selected).toEqual({ id: targetB.id, bucketConnection: targetB.bucketConnection });
  });

  it("returns no target when all capacity is exhausted", async () => {
    const { service } = createService([targetA], 800n);
    await expect(service.selectTarget("org", "namespace", 1n)).resolves.toBeNull();
  });
});
