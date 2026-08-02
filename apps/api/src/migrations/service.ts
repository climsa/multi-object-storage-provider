import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@mosp/db";
import type { MigrationCreateRequest } from "@mosp/shared";

const MAX_MIGRATION_ITEMS = 10_000;

export interface MigrationActionMetadata {
  actorId: string;
  requestId: string;
}

export interface MigrationRunSummary {
  completedAt: string | null;
  completedItems: number;
  createdAt: string;
  failedItems: number;
  id: string;
  lastError: string | null;
  namespaceId: string;
  sourceBucketConnectionId: string;
  startedAt: string | null;
  state: string;
  targetBucketConnectionId: string;
  totalItems: number;
  updatedAt: string;
}

export class MigrationNotFound extends Error {}
export class MigrationConflict extends Error {}
export class MigrationInvalidTarget extends Error {}
export class MigrationTooLarge extends Error {}

export class MigrationService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(organizationId: string): Promise<MigrationRunSummary[]> {
    const runs = await this.database.migrationRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return runs.map((run) => this.toSummary(run));
  }

  public async get(organizationId: string, migrationId: string): Promise<MigrationRunSummary> {
    const run = await this.database.migrationRun.findFirst({
      where: { id: migrationId, organizationId },
    });
    if (!run) throw new MigrationNotFound();
    return this.toSummary(run);
  }

  public async create(
    organizationId: string,
    input: MigrationCreateRequest,
    metadata: MigrationActionMetadata,
  ): Promise<MigrationRunSummary> {
    if (input.sourceBucketConnectionId === input.targetBucketConnectionId) {
      throw new MigrationInvalidTarget();
    }
    const [namespace, source, target, activeRun] = await Promise.all([
      this.database.virtualNamespace.findFirst({
        where: { id: input.namespaceId, organizationId, status: "ACTIVE" },
        select: { id: true },
      }),
      this.database.bucketConnection.findFirst({
        where: { id: input.sourceBucketConnectionId, organizationId, status: "ACTIVE", providerConnection: { status: "HEALTHY" } },
        select: { id: true },
      }),
      this.database.bucketConnection.findFirst({
        where: { id: input.targetBucketConnectionId, organizationId, status: "ACTIVE", providerConnection: { status: "HEALTHY" } },
        select: { id: true },
      }),
      this.database.migrationRun.findFirst({
        where: {
          organizationId,
          namespaceId: input.namespaceId,
          state: { in: ["CREATED", "RUNNING", "PAUSED"] },
        },
        select: { id: true },
      }),
    ]);
    if (!namespace || !source || !target) throw new MigrationInvalidTarget();
    if (activeRun) throw new MigrationConflict();

    const objects = await this.database.objectRecord.findMany({
      where: {
        organizationId,
        namespaceId: input.namespaceId,
        state: "AVAILABLE",
        activeObjectLocation: {
          is: { organizationId, bucketConnectionId: input.sourceBucketConnectionId, state: "ACTIVE" },
        },
      },
      orderBy: { logicalKey: "asc" },
      take: MAX_MIGRATION_ITEMS + 1,
      select: {
        id: true,
        sizeBytes: true,
        checksum: true,
        activeObjectLocation: {
          select: {
            id: true,
            physicalKey: true,
            bucketConnectionId: true,
            state: true,
            etag: true,
            providerLastModified: true,
          },
        },
      },
    });
    if (objects.length > MAX_MIGRATION_ITEMS) throw new MigrationTooLarge();

    const migrationId = randomUUID();
    const run = await this.database.$transaction(async (transaction) => {
      const created = await transaction.migrationRun.create({
        data: {
          id: migrationId,
          organizationId,
          namespaceId: input.namespaceId,
          sourceBucketConnectionId: input.sourceBucketConnectionId,
          targetBucketConnectionId: input.targetBucketConnectionId,
          initiatedById: metadata.actorId,
          totalItems: objects.length,
        },
      });
      if (objects.length > 0) {
        await transaction.migrationItem.createMany({
          data: objects.flatMap((object) => {
            const location = object.activeObjectLocation;
            if (!location || location.state !== "ACTIVE") return [];
            return [{
              id: randomUUID(),
              organizationId,
              migrationRunId: migrationId,
              objectRecordId: object.id,
              sourceLocationId: location.id,
              sourceBucketConnectionId: input.sourceBucketConnectionId,
              targetBucketConnectionId: input.targetBucketConnectionId,
              sourcePhysicalKey: location.physicalKey,
              targetPhysicalKey: `objects/${input.namespaceId}/migration/${migrationId}/${randomUUID()}`,
              sourceEtag: location.etag,
              sourceLastModified: location.providerLastModified,
              sizeBytes: object.sizeBytes,
              checksum: object.checksum,
            }];
          }),
        });
      }
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "migrations.create",
          entityType: "MigrationRun",
          entityId: migrationId,
          requestId: metadata.requestId,
          metadata: {
            namespaceId: input.namespaceId,
            sourceBucketConnectionId: input.sourceBucketConnectionId,
            targetBucketConnectionId: input.targetBucketConnectionId,
            totalItems: objects.length,
          },
        },
      });
      return created;
    });
    return this.toSummary(run);
  }

  public async control(
    organizationId: string,
    migrationId: string,
    action: "start" | "pause" | "cancel",
    metadata: MigrationActionMetadata,
  ): Promise<MigrationRunSummary> {
    const current = await this.database.migrationRun.findFirst({ where: { id: migrationId, organizationId } });
    if (!current) throw new MigrationNotFound();
    const transitions = {
      start: { from: ["CREATED", "PAUSED"] as const, to: "RUNNING" as const },
      pause: { from: ["RUNNING"] as const, to: "PAUSED" as const },
      cancel: { from: ["CREATED", "RUNNING", "PAUSED"] as const, to: "CANCELLED" as const },
    }[action];
    const allowedStates: readonly string[] = transitions.from;
    if (!allowedStates.includes(current.state)) {
      throw new MigrationConflict();
    }
    const update = await this.database.$transaction(async (transaction) => {
      const changed = await transaction.migrationRun.updateMany({
        where: { id: migrationId, organizationId, state: { in: [...transitions.from] } },
        data: {
          state: transitions.to,
          ...(action === "start" && !current.startedAt ? { startedAt: new Date() } : {}),
          ...(action === "cancel" ? { completedAt: new Date() } : {}),
        },
      });
      if (changed.count !== 1) throw new MigrationConflict();
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: `migrations.${action}`,
          entityType: "MigrationRun",
          entityId: migrationId,
          requestId: metadata.requestId,
          metadata: { previousState: current.state },
        },
      });
      return transaction.migrationRun.findFirstOrThrow({ where: { id: migrationId, organizationId } });
    });
    return this.toSummary(update);
  }

  private toSummary(run: {
    id: string; namespaceId: string; sourceBucketConnectionId: string; targetBucketConnectionId: string;
    state: string; totalItems: number; completedItems: number; failedItems: number; lastError: string | null;
    startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date;
  }): MigrationRunSummary {
    return {
      id: run.id,
      namespaceId: run.namespaceId,
      sourceBucketConnectionId: run.sourceBucketConnectionId,
      targetBucketConnectionId: run.targetBucketConnectionId,
      state: run.state,
      totalItems: run.totalItems,
      completedItems: run.completedItems,
      failedItems: run.failedItems,
      lastError: run.lastError,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }
}
