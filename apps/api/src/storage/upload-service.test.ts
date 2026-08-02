import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { PrismaClient } from "@mosp/db";

import type { ApiCredentialIdentity } from "../auth/api-credential.js";
import type { FolderGrantService } from "../folder-grants/service.js";
import type { ProviderConnectionService } from "../providers/service.js";
import { PlacementService } from "./placement-service.js";
import {
  UploadIdempotencyConflict,
  UploadQuotaExceeded,
  UploadProxySizeMismatch,
  UploadService,
} from "./upload-service.js";

const identity: ApiCredentialIdentity = {
  credentialId: "10000000-0000-4000-8000-000000000004",
  namespaceId: "10000000-0000-4000-8000-000000000003",
  organizationId: "10000000-0000-4000-8000-000000000002",
  principalId: "10000000-0000-4000-8000-000000000004",
  principalType: "API_CREDENTIAL",
};

const target = {
  id: "10000000-0000-4000-8000-000000000010",
  bucketConnection: {
    id: "10000000-0000-4000-8000-000000000011",
    bucketName: "archive",
    providerConnectionId: "10000000-0000-4000-8000-000000000012",
  },
};

function createConcurrentService(quotaBytes: bigint, defaultTransferMode = "DIRECT") {
  const uploads = new Map<string, Record<string, unknown>>();
  const usage = { usedBytes: 0n, reservedBytes: 0n, activeUploadCount: 0 };
  let queue = Promise.resolve();
  const adapter = {
    createPresignedUpload: vi.fn().mockResolvedValue({
      url: "https://storage.example/upload",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    }),
  };

  const findUpload = (where: Record<string, unknown>) => {
    const found = [...uploads.values()].find((upload) =>
      Object.entries(where).every(([key, value]) => upload[key] === value),
    );
    return found ? { ...found, bucketConnection: target.bucketConnection } : null;
  };

  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    usageCounter: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findUniqueOrThrow: vi.fn().mockResolvedValue(usage),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const reserved = data.reservedBytes as { increment?: bigint } | undefined;
        const active = data.activeUploadCount as { increment?: number } | undefined;
        if (reserved?.increment !== undefined) usage.reservedBytes += reserved.increment;
        if (active?.increment !== undefined) usage.activeUploadCount += active.increment;
        return Promise.resolve(usage);
      }),
    },
    uploadSession: {
      count: vi.fn().mockResolvedValue(uploads.size),
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const duplicate = [...uploads.values()].some((upload) =>
          upload.organizationId === data.organizationId &&
          upload.namespaceId === data.namespaceId &&
          upload.idempotencyKey === data.idempotencyKey &&
          upload.createdByCredentialId === data.createdByCredentialId,
        );
        if (duplicate) throw { code: "P2002" };
        uploads.set(String(data.id), data);
        return Promise.resolve({ ...data, bucketConnection: target.bucketConnection });
      }),
    },
  };

  const database = {
    virtualNamespace: {
      findFirst: vi.fn().mockResolvedValue({
        id: identity.namespaceId,
        status: "ACTIVE",
        quotaBytes,
        maxObjectSizeBytes: null,
        defaultTransferMode,
      }),
    },
    uploadSession: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findUpload(where))),
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({ organizationId: uploads.get(where.id)?.organizationId })),
    },
    objectRecord: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async <T>(callback: (transactionClient: typeof transaction) => Promise<T>) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(transaction);
      } finally {
        release();
      }
    }),
  } as unknown as PrismaClient;

  const grants = { canAccess: vi.fn().mockResolvedValue(true) } as unknown as FolderGrantService;
  const providers = { adapterFor: vi.fn().mockResolvedValue(adapter) } as unknown as ProviderConnectionService;
  const placement = {
    selectTarget: vi.fn().mockResolvedValue(target),
    assertTargetCapacity: vi.fn().mockResolvedValue(true),
  } as unknown as PlacementService;

  return {
    service: new UploadService(database, grants, providers, placement),
    adapter,
  };
}

describe("UploadService concurrency", () => {
  it("maps a concurrent idempotency unique race to a conflict", async () => {
    const { service } = createConcurrentService(1_000n);
    const input = {
      key: "photos/image.jpg",
      sizeBytes: "42",
      idempotencyKey: "upload-key-123",
      overwrite: false,
    } as const;

    const results = await Promise.allSettled([
      service.initiate(identity, "archive", input),
      service.initiate(identity, "archive", input),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      UploadIdempotencyConflict,
    );
  });

  it("serializes reservations so concurrent uploads cannot cross quota", async () => {
    const { service } = createConcurrentService(100n);
    const createInput = (key: string, idempotencyKey: string) => ({
      key,
      sizeBytes: "80",
      idempotencyKey,
      overwrite: false,
    } as const);

    const results = await Promise.allSettled([
      service.initiate(identity, "archive", createInput("photos/a.jpg", "upload-key-a")),
      service.initiate(identity, "archive", createInput("photos/b.jpg", "upload-key-b")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      UploadQuotaExceeded,
    );
  });
});

describe("UploadService proxied transfer", () => {
  it("reserves a PROXIED session without exposing a provider URL", async () => {
    const { service, adapter } = createConcurrentService(1_000n, "PROXIED");
    const upload = await service.initiate(identity, "archive", {
      key: "photos/image.jpg",
      sizeBytes: "42",
      idempotencyKey: "proxy-upload-123",
      overwrite: false,
    });

    expect(upload.transferMode).toBe("PROXIED");
    expect(upload.url).toBeUndefined();
    expect(adapter.createPresignedUpload).not.toHaveBeenCalled();
  });

  it("releases the reservation when the proxied body length is wrong", async () => {
    const session = {
      id: "20000000-0000-4000-8000-000000000001",
      organizationId: identity.organizationId,
      namespaceId: identity.namespaceId,
      createdByCredentialId: identity.credentialId,
      transferMode: "PROXIED",
      state: "INITIATED",
      reservedBytes: 42n,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      bucketConnection: { bucketName: "archive", providerConnectionId: "provider-1" },
    };
    const update = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      uploadSession: {
        findFirst: vi.fn().mockResolvedValue({ reservedBytes: session.reservedBytes }),
        update,
      },
      usageCounter: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const database = {
      uploadSession: { findFirst: vi.fn().mockResolvedValue(session) },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as PrismaClient;
    const providerService = { adapterFor: vi.fn() } as unknown as ProviderConnectionService;
    const service = new UploadService(
      database,
      { canAccess: vi.fn() } as unknown as FolderGrantService,
      providerService,
      {} as PlacementService,
    );

    await expect(
      service.proxyUpload(identity, session.id, Readable.from([Buffer.from("wrong")]), 5n),
    ).rejects.toBeInstanceOf(UploadProxySizeMismatch);
    expect(update).toHaveBeenCalledWith({
      where: { id: session.id },
      data: { state: "ABORTED" },
    });
    expect(providerService.adapterFor).not.toHaveBeenCalled();
  });
});
