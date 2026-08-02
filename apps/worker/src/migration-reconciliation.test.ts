import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

import { migrationErrorCode, MigrationReconciliationService } from "./migration-reconciliation.js";

describe("migration reconciliation", () => {
  it("does not call a provider when no runnable items exist", async () => {
    const providerService = { adapterFor: vi.fn() };
    const database = {
      migrationItem: { findMany: vi.fn().mockResolvedValue([]) },
      migrationRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;
    const service = new MigrationReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    );

    await expect(service.reconcile()).resolves.toEqual({ completed: 0, failed: 0 });
    expect(providerService.adapterFor).not.toHaveBeenCalled();
  });

  it("rejects unsafe worker batch sizes", async () => {
    const database = {
      migrationItem: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const service = new MigrationReconciliationService(database, { adapterFor: vi.fn() } as never);

    await expect(service.reconcile({ batchSize: 0 })).rejects.toThrow(RangeError);
    await expect(service.reconcile({ batchSize: 101 })).rejects.toThrow(RangeError);
  });

  it("rejects unsafe per-provider concurrency", async () => {
    const database = {
      migrationItem: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    const service = new MigrationReconciliationService(database, { adapterFor: vi.fn() } as never);

    await expect(service.reconcile({ maxConcurrentPerProvider: 0 })).rejects.toThrow(RangeError);
    await expect(service.reconcile({ maxConcurrentPerProvider: 21 })).rejects.toThrow(RangeError);
  });

  it("serializes items sharing a provider lock when the limit is one", async () => {
    const items = [
      { id: "item-a", organizationId: "org-a", state: "PENDING", updatedAt: new Date() },
      { id: "item-b", organizationId: "org-a", state: "PENDING", updatedAt: new Date() },
    ];
    const database = {
      migrationItem: {
        findMany: vi.fn().mockResolvedValueOnce(items).mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      migrationRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;
    const service = new MigrationReconciliationService(database, { adapterFor: vi.fn() } as never);
    const serviceInternals = service as unknown as {
      providerKeysForItem: (item: unknown) => Promise<string[]>;
      processItem: (item: unknown, previousState: string) => Promise<"completed" | "failed" | "skipped">;
    };
    vi.spyOn(serviceInternals, "providerKeysForItem").mockResolvedValue(["provider-a"]);
    let active = 0;
    let maximum = 0;
    vi.spyOn(serviceInternals, "processItem").mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return "completed";
    });

    await expect(service.reconcile({ maxConcurrentPerProvider: 1 })).resolves.toEqual({
      completed: 2,
      failed: 0,
    });
    expect(maximum).toBe(1);
  });

  it("redacts provider error messages to stable migration codes", () => {
    expect(migrationErrorCode(new Error("https://secret.example/provider?accessKey=redacted"))).toBe(
      "MIGRATION_FAILED",
    );
    expect(migrationErrorCode({ $metadata: { httpStatusCode: 404 } })).toBe(
      "PROVIDER_OBJECT_NOT_FOUND",
    );
    expect(migrationErrorCode({ $metadata: { httpStatusCode: 503 } })).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(migrationErrorCode(new Error("MIGRATION_CHECKSUM_MISMATCH"))).toBe(
      "MIGRATION_CHECKSUM_MISMATCH",
    );
  });

  it("keeps an item retryable and stores only a stable code on provider outage", async () => {
    const item = {
      id: "10000000-0000-4000-8000-000000000010",
      organizationId: "10000000-0000-4000-8000-000000000002",
      migrationRunId: "10000000-0000-4000-8000-000000000011",
      objectRecordId: "10000000-0000-4000-8000-000000000012",
      sourceLocationId: "10000000-0000-4000-8000-000000000013",
      sourceBucketConnectionId: "10000000-0000-4000-8000-000000000014",
      targetBucketConnectionId: "10000000-0000-4000-8000-000000000015",
      sourcePhysicalKey: "objects/source",
      targetPhysicalKey: "objects/target",
      sizeBytes: 42n,
      checksum: null,
      state: "PENDING",
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const transaction = {
      migrationItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      migrationRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const outage = Object.assign(new Error("provider endpoint secret"), {
      $metadata: { httpStatusCode: 503 },
    });
    const adapter = {
      getObject: vi.fn().mockRejectedValue(outage),
    };
    const database = {
      migrationItem: {
        findMany: vi.fn()
          .mockResolvedValueOnce([item])
          .mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      bucketConnection: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({ bucketName: "source", providerConnectionId: "source-provider" })
          .mockResolvedValueOnce({ bucketName: "target", providerConnectionId: "target-provider" }),
      },
      migrationRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const providerService = {
      adapterFor: vi.fn().mockResolvedValue(adapter),
    };
    const service = new MigrationReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    );

    await expect(service.reconcile({ now: new Date("2030-01-01T00:00:00.000Z") }))
      .resolves.toEqual({ completed: 0, failed: 1 });
    expect(transaction.migrationItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: "FAILED", lastError: "PROVIDER_UNAVAILABLE" }),
    }));
    expect(JSON.stringify(transaction.migrationItem.updateMany.mock.calls)).not.toContain("provider endpoint secret");
  });

  it("deletes the candidate when the source changes during copy", async () => {
    const item = {
      id: "10000000-0000-4000-8000-000000000020",
      organizationId: "10000000-0000-4000-8000-000000000002",
      migrationRunId: "10000000-0000-4000-8000-000000000021",
      objectRecordId: "10000000-0000-4000-8000-000000000022",
      sourceLocationId: "10000000-0000-4000-8000-000000000023",
      sourceBucketConnectionId: "10000000-0000-4000-8000-000000000024",
      targetBucketConnectionId: "10000000-0000-4000-8000-000000000025",
      sourcePhysicalKey: "objects/source",
      targetPhysicalKey: "objects/target",
      sourceEtag: "etag-before",
      sourceLastModified: null,
      sizeBytes: 5n,
      checksum: null,
      state: "PENDING",
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const transaction = {
      migrationItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      migrationRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const adapter = {
      getObject: vi.fn().mockResolvedValue({
        body: Readable.from(["hello"]),
        metadata: { sizeBytes: 5n, etag: "etag-before" },
      }),
      putObject: vi.fn().mockResolvedValue(undefined),
      headObject: vi.fn().mockResolvedValue({ sizeBytes: 5n, etag: "etag-after" }),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      migrationItem: {
        findMany: vi.fn().mockResolvedValueOnce([item]).mockResolvedValueOnce([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      bucketConnection: {
        findFirst: vi.fn()
          .mockResolvedValueOnce({ bucketName: "source", providerConnectionId: "source-provider" })
          .mockResolvedValueOnce({ bucketName: "target", providerConnectionId: "target-provider" }),
      },
      migrationRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const providerService = { adapterFor: vi.fn().mockResolvedValue(adapter) };
    const service = new MigrationReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    );

    await expect(service.reconcile({ now: new Date("2030-01-01T00:00:00.000Z") }))
      .resolves.toEqual({ completed: 0, failed: 1 });
    expect(adapter.putObject).toHaveBeenCalledWith(
      "target",
      item.targetPhysicalKey,
      expect.anything(),
      undefined,
      5,
    );
    expect(adapter.deleteObject).toHaveBeenCalledWith("target", item.targetPhysicalKey);
    expect(transaction.migrationItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: "FAILED", lastError: "SOURCE_CHANGED" }),
    }));
  });
});
