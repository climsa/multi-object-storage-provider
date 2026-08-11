import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";

import type { ProviderConnectionService } from "../providers/service.js";
import { BucketConnectionNotActive, BucketConnectionService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const providerId = "10000000-0000-4000-8000-000000000003";

describe("BucketConnectionService.import", () => {
  it("checks bucket access without requiring provider write capabilities", async () => {
    const adapter = {
      testBucketAccess: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn(),
    };
    const providerService = {
      adapterFor: vi.fn().mockResolvedValue(adapter),
    } as unknown as ProviderConnectionService;
    const created = {
      id: "10000000-0000-4000-8000-000000000004",
      bucketName: "photos",
      providerConnectionId: providerId,
      status: "ACTIVE",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const transaction = {
      bucketConnection: { create: vi.fn().mockResolvedValue(created) },
      activityLog: { create: vi.fn().mockResolvedValue(undefined) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as PrismaClient;

    const service = new BucketConnectionService(database, providerService);
    const result = await service.import(
      organizationId,
      { providerConnectionId: providerId, bucketName: "photos" },
      { actorId: "10000000-0000-4000-8000-000000000001", requestId: "request-1" },
    );

    expect(result.bucketName).toBe("photos");
    expect(adapter.testBucketAccess).toHaveBeenCalledWith("photos");
    expect(adapter.testConnection).not.toHaveBeenCalled();
  });
});

describe("BucketConnectionService.listObjects", () => {
  it("lists raw provider objects only through an organization-scoped bucket connection", async () => {
    const adapter = {
      listObjects: vi.fn().mockResolvedValue({
        commonPrefixes: ["photos/2029/"],
        nextContinuationToken: "next-cursor",
        objects: [{
          etag: "etag-1",
          key: "photos/image.jpg",
          lastModified: new Date("2030-01-01T00:00:00.000Z"),
          sizeBytes: 42n,
          storageClass: "STANDARD",
        }],
      }),
    };
    const providerService = {
      adapterFor: vi.fn().mockResolvedValue(adapter),
    } as unknown as ProviderConnectionService;
    const findFirst = vi.fn().mockResolvedValue({
      bucketName: "archive",
      id: "10000000-0000-4000-8000-000000000004",
      providerConnectionId: providerId,
      status: "ACTIVE",
    });
    const database = {
      bucketConnection: { findFirst },
    } as unknown as PrismaClient;

    const result = await new BucketConnectionService(database, providerService).listObjects(
      organizationId,
      "10000000-0000-4000-8000-000000000004",
      { cursor: "current-cursor", limit: 25, prefix: "photos/" },
    );

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "10000000-0000-4000-8000-000000000004",
        organizationId,
      },
    }));
    expect(providerService.adapterFor).toHaveBeenCalledWith(organizationId, providerId);
    expect(adapter.listObjects).toHaveBeenCalledWith("archive", {
      continuationToken: "current-cursor",
      delimiter: "/",
      maxKeys: 25,
      prefix: "photos/",
    });
    expect(result).toEqual({
      bucket: { id: "10000000-0000-4000-8000-000000000004", name: "archive" },
      folders: ["photos/2029/"],
      nextCursor: "next-cursor",
      objects: [{
        etag: "etag-1",
        key: "photos/image.jpg",
        lastModified: "2030-01-01T00:00:00.000Z",
        sizeBytes: "42",
        storageClass: "STANDARD",
      }],
      prefix: "photos/",
    });
  });

  it("does not access a provider for a disabled bucket connection", async () => {
    const providerService = {
      adapterFor: vi.fn(),
    } as unknown as ProviderConnectionService;
    const database = {
      bucketConnection: {
        findFirst: vi.fn().mockResolvedValue({
          bucketName: "archive",
          id: "10000000-0000-4000-8000-000000000004",
          providerConnectionId: providerId,
          status: "DISABLED",
        }),
      },
    } as unknown as PrismaClient;

    await expect(new BucketConnectionService(database, providerService).listObjects(
      organizationId,
      "10000000-0000-4000-8000-000000000004",
      { limit: 100, prefix: "" },
    )).rejects.toBeInstanceOf(BucketConnectionNotActive);
    expect(providerService.adapterFor).not.toHaveBeenCalled();
  });
});
