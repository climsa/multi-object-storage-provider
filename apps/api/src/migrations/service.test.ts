import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";

import {
  MigrationConflict,
  MigrationInvalidTarget,
  MigrationNotFound,
  MigrationService,
} from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const otherOrganizationId = "10000000-0000-4000-8000-000000000003";
const namespaceId = "10000000-0000-4000-8000-000000000004";
const sourceId = "10000000-0000-4000-8000-000000000005";
const targetId = "10000000-0000-4000-8000-000000000006";

const metadata = { actorId: "10000000-0000-4000-8000-000000000001", requestId: "request-1" };

function createDatabase(overrides: Record<string, unknown> = {}) {
  const database = {
    virtualNamespace: { findFirst: vi.fn().mockResolvedValue({ id: namespaceId }) },
    bucketConnection: {
      findFirst: vi.fn()
        .mockResolvedValueOnce({ id: sourceId })
        .mockResolvedValueOnce({ id: targetId }),
    },
    migrationRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    objectRecord: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
    ...overrides,
  } as unknown as PrismaClient;
  return database;
}

describe("MigrationService tenant and concurrency boundaries", () => {
  it("rejects a namespace that belongs to another organization", async () => {
    const database = createDatabase({
      virtualNamespace: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const service = new MigrationService(database);

    await expect(service.create(
      organizationId,
      { namespaceId, sourceBucketConnectionId: sourceId, targetBucketConnectionId: targetId },
      metadata,
    )).rejects.toBeInstanceOf(MigrationInvalidTarget);
    expect(database.objectRecord.findMany).not.toHaveBeenCalled();
  });

  it("rejects a migration lookup outside the organization scope", async () => {
    const database = createDatabase({
      migrationRun: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const service = new MigrationService(database);

    await expect(service.get(otherOrganizationId, "10000000-0000-4000-8000-000000000010"))
      .rejects.toBeInstanceOf(MigrationNotFound);
  });

  it("rejects a second active migration for the same namespace", async () => {
    const database = createDatabase({
      migrationRun: { findFirst: vi.fn().mockResolvedValue({ id: "existing" }) },
    });
    const service = new MigrationService(database);

    await expect(service.create(
      organizationId,
      { namespaceId, sourceBucketConnectionId: sourceId, targetBucketConnectionId: targetId },
      metadata,
    )).rejects.toBeInstanceOf(MigrationConflict);
  });
});
