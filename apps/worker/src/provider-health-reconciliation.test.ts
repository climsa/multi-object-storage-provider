import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

import {
  providerHealthErrorCode,
  ProviderHealthReconciliationService,
} from "./provider-health-reconciliation.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const providerId = "10000000-0000-4000-8000-000000000003";

describe("provider health reconciliation", () => {
  it("records healthy status and capabilities without writing audit noise", async () => {
    const adapter = {
      testConnection: vi.fn().mockResolvedValue({
        bucketNames: ["archive"],
        capabilities: [{ capability: "listBuckets", supported: true }],
      }),
    };
    const transaction = {
      providerConnection: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      providerCapability: { upsert: vi.fn().mockResolvedValue(undefined) },
    };
    const database = {
      providerConnection: {
        findMany: vi.fn().mockResolvedValue([{ id: providerId, organizationId }]),
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const providerService = { adapterFor: vi.fn().mockResolvedValue(adapter) };

    const result = await new ProviderHealthReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    ).reconcile({ now: new Date("2030-01-01T00:00:00.000Z") });

    expect(result).toEqual({ healthy: 1, unhealthy: 0 });
    expect(transaction.providerConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "HEALTHY" }),
    }));
    expect(transaction.providerCapability.upsert).toHaveBeenCalledOnce();
  });

  it("marks provider outages with a stable code and no raw error", async () => {
    const outage = Object.assign(new Error("https://secret.example/?accessKey=secret"), {
      $metadata: { httpStatusCode: 503 },
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      providerConnection: {
        findMany: vi.fn().mockResolvedValue([{ id: providerId, organizationId }]),
        updateMany,
      },
    } as unknown as PrismaClient;
    const providerService = {
      adapterFor: vi.fn().mockResolvedValue({ testConnection: vi.fn().mockRejectedValue(outage) }),
    };

    const result = await new ProviderHealthReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    ).reconcile();

    expect(result).toEqual({ healthy: 0, unhealthy: 1 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "UNHEALTHY", lastHealthCheckedAt: expect.any(Date), healthDetails: { code: "PROVIDER_UNAVAILABLE" } },
    }));
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("accessKey=secret");
  });

  it("records recovery after a subsequent successful health check", async () => {
    const adapter = {
      testConnection: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("provider unavailable"), { $metadata: { httpStatusCode: 503 } }))
        .mockResolvedValueOnce({
          bucketNames: ["archive"],
          capabilities: [{ capability: "listBuckets", supported: true }],
        }),
    };
    const transaction = {
      providerConnection: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      providerCapability: { upsert: vi.fn().mockResolvedValue(undefined) },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      providerConnection: {
        findMany: vi.fn().mockResolvedValue([{ id: providerId, organizationId }]),
        updateMany,
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const providerService = { adapterFor: vi.fn().mockResolvedValue(adapter) };
    const service = new ProviderHealthReconciliationService(
      database,
      providerService as unknown as { adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter> },
    );

    const outage = await service.reconcile({ now: new Date("2030-01-01T00:00:00.000Z") });
    const recovery = await service.reconcile({ now: new Date("2030-01-01T00:01:00.000Z") });

    expect(outage).toEqual({ healthy: 0, unhealthy: 1 });
    expect(recovery).toEqual({ healthy: 1, unhealthy: 0 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNHEALTHY" }),
    }));
    expect(transaction.providerConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "HEALTHY" }),
    }));
    expect(adapter.testConnection).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe batch sizes and maps provider statuses", async () => {
    const database = { providerConnection: { findMany: vi.fn() } } as unknown as PrismaClient;
    const service = new ProviderHealthReconciliationService(database, { adapterFor: vi.fn() } as never);
    await expect(service.reconcile({ batchSize: 0 })).rejects.toThrow(RangeError);
    expect(providerHealthErrorCode({ $metadata: { httpStatusCode: 401 } })).toBe("PROVIDER_AUTH_FAILED");
    expect(providerHealthErrorCode({ $metadata: { httpStatusCode: 503 } })).toBe("PROVIDER_UNAVAILABLE");
  });
});
