import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

import { UploadReconciliationService } from "./upload-reconciliation.js";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  namespaceId: "10000000-0000-4000-8000-000000000003",
  physicalKey: "objects/namespace/upload",
  reservedBytes: 42n,
  bucketConnection: {
    bucketName: "archive",
    providerConnectionId: "10000000-0000-4000-8000-000000000004",
  },
  transferMode: "DIRECT",
  providerUploadId: null,
  providerUploadFinalized: false,
};

function createService(changedCount = 1, multipart = false, finalized = false, objectExists = false) {
  const adapter = {
    deleteObject: vi.fn().mockResolvedValue(undefined),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    objectExists: vi.fn().mockResolvedValue(objectExists),
  } as unknown as S3ProviderAdapter;
  const providerService = {
    adapterFor: vi.fn().mockResolvedValue(adapter),
  };
  const transaction = {
    uploadSession: { updateMany: vi.fn().mockResolvedValue({ count: changedCount }) },
    usageCounter: {
      upsert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const database = {
    uploadSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          ...session,
          ...(multipart
            ? {
                transferMode: "MULTIPART",
                providerUploadId: "provider-upload-1",
                providerUploadFinalized: finalized,
              }
            : {}),
          expiresAt: new Date("2020-01-01"),
        },
      ]),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
  } as unknown as PrismaClient;
  return { adapter, database, providerService, service: new UploadReconciliationService(database, providerService) };
}

describe("upload reconciliation", () => {
  it("deletes the physical object before releasing the reservation", async () => {
    const { adapter, database, service } = createService();
    const result = await service.reconcile({ now: new Date("2030-01-01"), batchSize: 10 });

    expect(result).toEqual({ expired: 1, failed: 0 });
    expect(adapter.deleteObject).toHaveBeenCalledWith("archive", session.physicalKey);
    expect(database.$transaction).toHaveBeenCalledOnce();
  });

  it("keeps the reservation when provider deletion fails", async () => {
    const { adapter, database, service } = createService();
    vi.mocked(adapter.deleteObject).mockRejectedValue(new Error("provider unavailable"));

    const result = await service.reconcile();

    expect(result).toEqual({ expired: 0, failed: 1 });
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("aborts a provider multipart session instead of deleting a completed key", async () => {
    const { adapter, service } = createService(1, true);

    const result = await service.reconcile();

    expect(result).toEqual({ expired: 1, failed: 0 });
    expect(adapter.abortMultipartUpload).toHaveBeenCalledWith(
      "archive",
      session.physicalKey,
      "provider-upload-1",
    );
    expect(adapter.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes a provider object after multipart completion was already finalized", async () => {
    const { adapter, service } = createService(1, true, true);

    const result = await service.reconcile();

    expect(result).toEqual({ expired: 1, failed: 0 });
    expect(adapter.deleteObject).toHaveBeenCalledWith("archive", session.physicalKey);
    expect(adapter.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("deletes a completed provider object when the finalization flag was not committed", async () => {
    const { adapter, service } = createService(1, true, false, true);

    const result = await service.reconcile();

    expect(result).toEqual({ expired: 1, failed: 0 });
    expect(adapter.objectExists).toHaveBeenCalledWith("archive", session.physicalKey);
    expect(adapter.deleteObject).toHaveBeenCalledWith("archive", session.physicalKey);
    expect(adapter.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("does not release quota when another lifecycle action won the race", async () => {
    const { database, service } = createService(0);

    const result = await service.reconcile();

    expect(result).toEqual({ expired: 0, failed: 0 });
    expect(database.$transaction).toHaveBeenCalledOnce();
  });

  it("rejects unsafe batch sizes", async () => {
    const { service } = createService();
    await expect(service.reconcile({ batchSize: 0 })).rejects.toThrow(RangeError);
    await expect(service.reconcile({ batchSize: 1001 })).rejects.toThrow(RangeError);
  });
});
