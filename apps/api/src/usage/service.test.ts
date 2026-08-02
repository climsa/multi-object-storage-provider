import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";

import { UsageService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";

describe("UsageService", () => {
  it("returns organization totals and paginated namespace usage", async () => {
    const database = {
      virtualNamespace: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: namespaceId,
            name: "Archive",
            slug: "archive",
            status: "ACTIVE",
            quotaBytes: 1000n,
            usageCounters: [{
              usedBytes: 42n,
              reservedBytes: 8n,
              objectCount: 2n,
              activeUploadCount: 1,
              requestCount: 9n,
              ingressBytes: 42n,
              egressBytes: 10n,
              updatedAt: new Date("2030-01-01T00:00:00.000Z"),
            }],
          },
        ]),
      },
      usageCounter: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: {
            usedBytes: 42n,
            reservedBytes: 8n,
            objectCount: 2n,
            activeUploadCount: 1,
            requestCount: 9n,
            ingressBytes: 42n,
            egressBytes: 10n,
          },
        }),
      },
    } as unknown as PrismaClient;

    const result = await new UsageService(database).list(organizationId, { limit: 50 });

    expect(result.namespaces[0]).toMatchObject({
      namespaceId,
      usedBytes: "42",
      requestCount: "9",
      egressBytes: "10",
    });
    expect(result.totals).toMatchObject({ usedBytes: "42", egressBytes: "10" });
    expect(result.nextCursor).toBeNull();
    expect(database.usageCounter.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId },
    }));
  });

  it("records request and egress counters atomically through upsert", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const database = { usageCounter: { upsert } } as unknown as PrismaClient;
    const service = new UsageService(database);

    await service.recordRequest(organizationId, namespaceId);
    await service.recordEgress(organizationId, namespaceId, 42n);

    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      update: { requestCount: { increment: 1n } },
    }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      update: { egressBytes: { increment: 42n } },
    }));
  });

  it("rejects negative egress values", async () => {
    const database = { usageCounter: { upsert: vi.fn() } } as unknown as PrismaClient;
    await expect(new UsageService(database).recordEgress(organizationId, namespaceId, -1n))
      .rejects.toThrow(RangeError);
  });

  it("escapes CSV values and preserves a bounded export page", () => {
    const csv = UsageService.toCsv({
      namespaces: [{
        namespaceId,
        name: "Archive, primary",
        slug: "archive",
        status: "ACTIVE",
        quotaBytes: "1000",
        usedBytes: "42",
        reservedBytes: "8",
        objectCount: "2",
        activeUploadCount: 1,
        requestCount: "9",
        ingressBytes: "42",
        egressBytes: "10",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }],
      nextCursor: "10000000-0000-4000-8000-000000000004",
      totals: {
        usedBytes: "42",
        reservedBytes: "8",
        objectCount: "2",
        activeUploadCount: 1,
        requestCount: "9",
        ingressBytes: "42",
        egressBytes: "10",
      },
    });

    expect(csv).toContain('"Archive, primary"');
    expect(csv.split("\n")).toHaveLength(3);
  });
});
