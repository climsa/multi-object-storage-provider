import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { PrismaClient } from "@mosp/db";
import { FolderGrantService } from "../folder-grants/service.js";
import type { ProviderConnectionService } from "../providers/service.js";
import type { UsageService } from "../usage/service.js";
import {
  ObjectIndexService,
  StorageDeleteUnavailable,
  StorageDownloadUnavailable,
  StorageObjectNotFound,
} from "./object-service.js";
import type { ApiCredentialIdentity } from "../auth/api-credential.js";

const identity: ApiCredentialIdentity = {
  credentialId: "10000000-0000-4000-8000-000000000004",
  namespaceId: "10000000-0000-4000-8000-000000000003",
  organizationId: "10000000-0000-4000-8000-000000000002",
  principalId: "10000000-0000-4000-8000-000000000004",
  principalType: "API_CREDENTIAL",
};

function record(key: string, state = "ACTIVE") {
  return {
    logicalKey: key,
    sizeBytes: 42n,
    contentType: "text/plain",
    checksum: null,
    modifiedAt: new Date("2030-01-01T00:00:00.000Z"),
    activeObjectLocation: { state, etag: "etag" },
  };
}

describe("ObjectIndexService", () => {
  it("filters list results through the FolderGrant evaluator", async () => {
    const folderGrantService = {
      canAccess: vi.fn().mockImplementation(({ key }) =>
        key === "photos" || key === "photos/allowed.txt",
      ),
    } as unknown as FolderGrantService;
    const database = {
      virtualNamespace: {
        findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }),
      },
      objectRecord: {
        findMany: vi.fn().mockResolvedValue([
          record("photos/allowed.txt"),
          record("photos/hidden.txt"),
          record("photos/candidate.txt", "CANDIDATE"),
        ]),
      },
    } as unknown as PrismaClient;

    const objects = await new ObjectIndexService(database, folderGrantService).list(
      identity,
      "archive",
      { prefix: "photos", limit: 100 },
    );

    expect(objects.map((object) => object.key)).toEqual(["photos/allowed.txt"]);
  });

  it("returns 404 semantics for an object without read grant", async () => {
    const folderGrantService = {
      canAccess: vi.fn().mockResolvedValue(false),
    } as unknown as FolderGrantService;
    const database = {
      virtualNamespace: {
        findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }),
      },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue(record("photos/hidden.txt")),
      },
    } as unknown as PrismaClient;

    await expect(
      new ObjectIndexService(database, folderGrantService).head(
        identity,
        "archive",
        "photos/hidden.txt",
      ),
    ).rejects.toBeInstanceOf(StorageObjectNotFound);
  });

  it("claims, deletes, and finalizes an object while releasing usage", async () => {
    const adapter = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const transaction = {
      objectRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      objectLocation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      usageCounter: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
      activityLog: { create: vi.fn().mockResolvedValue(undefined) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const database = {
      virtualNamespace: {
        findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }),
      },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          id: "10000000-0000-4000-8000-000000000020",
          sizeBytes: 42n,
          state: "AVAILABLE",
          activeObjectLocation: {
            id: "10000000-0000-4000-8000-000000000021",
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "10000000-0000-4000-8000-000000000022" },
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = { adapterFor: vi.fn().mockResolvedValue(adapter) };

    await new ObjectIndexService(database, grants, providers as unknown as ProviderConnectionService).delete(identity, "archive", "photos/file.txt", "request-1");

    expect(adapter.deleteObject).toHaveBeenCalledWith("archive", "objects/key");
    expect(transaction.usageCounter.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ usedBytes: { decrement: 42n }, objectCount: { decrement: 1n } }),
    }));
    expect(transaction.activityLog.create).toHaveBeenCalledTimes(2);
  });

  it("restores AVAILABLE state when the provider delete fails", async () => {
    const database = {
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }) },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          id: "10000000-0000-4000-8000-000000000020",
          sizeBytes: 42n,
          activeObjectLocation: {
            id: "10000000-0000-4000-8000-000000000021",
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "provider" },
          },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({
        objectRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        activityLog: { create: vi.fn().mockResolvedValue(undefined) },
      })),
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = { adapterFor: vi.fn().mockResolvedValue({ deleteObject: vi.fn().mockRejectedValue(new Error("down")) }) };

    await expect(new ObjectIndexService(database, grants, providers as unknown as ProviderConnectionService).delete(identity, "archive", "photos/file.txt", "request-1")).rejects.toBeInstanceOf(StorageDeleteUnavailable);
    expect(database.objectRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { state: "AVAILABLE" } }));
  });

  it("maps a provider download outage to a safe availability error", async () => {
    const database = {
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }) },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          logicalKey: "photos/file.txt",
          activeObjectLocation: {
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "provider" },
          },
        }),
      },
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = {
      adapterFor: vi.fn().mockResolvedValue({
        createPresignedDownload: vi.fn().mockRejectedValue(new Error("provider endpoint secret")),
      }),
    };

    await expect(
      new ObjectIndexService(database, grants, providers as unknown as ProviderConnectionService)
        .presignDownload(identity, "archive", "photos/file.txt"),
    ).rejects.toBeInstanceOf(StorageDownloadUnavailable);
  });

  it("records estimated egress after a successful presigned download", async () => {
    const database = {
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }) },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          sizeBytes: 42n,
          activeObjectLocation: {
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "provider" },
          },
        }),
      },
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = {
      adapterFor: vi.fn().mockResolvedValue({
        createPresignedDownload: vi.fn().mockResolvedValue({
          url: "https://storage.example/download",
          expiresAt: new Date("2030-01-01T00:15:00.000Z"),
        }),
      }),
    };
    const usageService = { recordEgress: vi.fn().mockResolvedValue(undefined) } as unknown as UsageService;

    const result = await new ObjectIndexService(
      database,
      grants,
      providers as unknown as ProviderConnectionService,
      usageService,
    ).presignDownload(identity, "archive", "photos/file.txt");

    expect(result.url).toBe("https://storage.example/download");
    expect(usageService.recordEgress).toHaveBeenCalledWith(
      identity.organizationId,
      identity.namespaceId,
      42n,
    );
  });

  it("streams a proxied object only after provider metadata matches the index", async () => {
    const body = Readable.from([Buffer.from("payload")]);
    const getObject = vi.fn().mockResolvedValue({
      body,
      metadata: { sizeBytes: 42n, contentType: "text/plain", etag: "etag" },
    });
    const database = {
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }) },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          sizeBytes: 42n,
          activeObjectLocation: {
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "provider" },
          },
        }),
      },
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = {
      adapterFor: vi.fn().mockResolvedValue({ getObject }),
    } as unknown as ProviderConnectionService;
    const signal = new AbortController().signal;

    const transfer = await new ObjectIndexService(database, grants, providers).proxyDownload(
      identity,
      "archive",
      "photos/file.txt",
      signal,
    );

    expect(transfer.metadata.sizeBytes).toBe(42n);
    expect(providers.adapterFor).toHaveBeenCalledWith(identity.organizationId, "provider", 300_000);
    expect(getObject).toHaveBeenCalledWith("archive", "objects/key", signal);
  });

  it("rejects and destroys a proxied stream when provider size is inconsistent", async () => {
    const body = Readable.from([Buffer.from("short")]);
    const destroy = vi.spyOn(body, "destroy");
    const database = {
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: identity.namespaceId, status: "ACTIVE" }) },
      objectRecord: {
        findFirst: vi.fn().mockResolvedValue({
          sizeBytes: 42n,
          activeObjectLocation: {
            state: "ACTIVE",
            physicalKey: "objects/key",
            bucketConnection: { bucketName: "archive", providerConnectionId: "provider" },
          },
        }),
      },
    } as unknown as PrismaClient;
    const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
    const providers = {
      adapterFor: vi.fn().mockResolvedValue({
        getObject: vi.fn().mockResolvedValue({ body, metadata: { sizeBytes: 41n } }),
      }),
    } as unknown as ProviderConnectionService;

    await expect(
      new ObjectIndexService(database, grants, providers).proxyDownload(
        identity,
        "archive",
        "photos/file.txt",
      ),
    ).rejects.toBeInstanceOf(StorageDownloadUnavailable);
    expect(destroy).toHaveBeenCalled();
  });
});
