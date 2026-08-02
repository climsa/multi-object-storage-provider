import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

export interface MigrationReconciliationOptions {
  batchSize?: number;
  now?: Date;
  maxConcurrentPerProvider?: number;
  retryDelayMs?: number;
}

export interface MigrationReconciliationResult {
  completed: number;
  failed: number;
}

type MigrationAdapterResolver = {
  adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter>;
};

const STALE_COPYING_MS = 15 * 60 * 1000;
const SAFE_MIGRATION_ERRORS = new Set([
  "MIGRATION_BUCKET_NOT_FOUND",
  "MIGRATION_SIZE_MISMATCH",
  "MIGRATION_CHECKSUM_MISMATCH",
  "MIGRATION_SIZE_UNSUPPORTED",
  "CANCELLED",
  "RUN_NOT_RUNNING",
  "SOURCE_CHANGED",
]);

export class MigrationReconciliationService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly providerService: MigrationAdapterResolver,
  ) {}

  public async reconcile(
    options: MigrationReconciliationOptions = {},
  ): Promise<MigrationReconciliationResult> {
    const now = options.now ?? new Date();
    const batchSize = this.safeBatchSize(options.batchSize ?? 20);
    const maxConcurrentPerProvider = this.safeConcurrency(options.maxConcurrentPerProvider ?? 2);
    const retryDelayMs = this.safeRetryDelay(options.retryDelayMs ?? 60_000);
    const items = await this.database.migrationItem.findMany({
      where: {
        migrationRun: { state: "RUNNING" },
        OR: [
          { state: "PENDING" },
          { state: "FAILED", nextAttemptAt: { lte: now } },
          { state: "COPYING", updatedAt: { lte: new Date(now.getTime() - STALE_COPYING_MS) } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
      include: { migrationRun: { select: { state: true } } },
    });

    const claimedItems: Array<{ item: (typeof items)[number]; previousState: string; providerKeys: string[] }> = [];
    for (const item of items) {
      const previousState = item.state;
      const claimed = await this.claim(item.id, item.organizationId, previousState);
      if (!claimed) continue;
      claimedItems.push({
        item,
        previousState,
        providerKeys: await this.providerKeysForItem(item),
      });
    }

    let completed = 0;
    let failed = 0;
    let pending = claimedItems;
    while (pending.length > 0) {
      const selected: typeof claimedItems = [];
      const deferred: typeof claimedItems = [];
      const activeByProvider = new Map<string, number>();

      for (const work of pending) {
        const canRun = work.providerKeys.every(
          (key) => (activeByProvider.get(key) ?? 0) < maxConcurrentPerProvider,
        );
        if (!canRun && selected.length > 0) {
          deferred.push(work);
          continue;
        }
        selected.push(work);
        for (const key of work.providerKeys) {
          activeByProvider.set(key, (activeByProvider.get(key) ?? 0) + 1);
        }
      }

      // A work item may share both provider locks with every other item. Always
      // make progress rather than waiting indefinitely for an empty batch.
      if (selected.length === 0) {
        const first = pending[0];
        if (!first) break;
        selected.push(first);
      }
      pending = deferred;

      const results = await Promise.all(
        selected.map(({ item, previousState }) => this.processItem(item, previousState, retryDelayMs)),
      );
      for (const result of results) {
        if (result === "completed") completed += 1;
        if (result === "failed") failed += 1;
      }
    }
    failed += await this.reconcileCancelledItems(batchSize);
    await this.completeEmptyRuns();
    return { completed, failed };
  }

  private async processItem(
    item: (Awaited<ReturnType<PrismaClient["migrationItem"]["findMany"]>>)[number],
    previousState: string,
    retryDelayMs: number,
  ): Promise<"completed" | "failed" | "skipped"> {
    let sourceBody: Readable | undefined;
    let targetAdapter: S3ProviderAdapter | undefined;
    let targetBucketName: string | undefined;
    let targetCopied = false;
    try {
      const [sourceBucket, targetBucket] = await Promise.all([
        this.database.bucketConnection.findFirst({
          where: { id: item.sourceBucketConnectionId, organizationId: item.organizationId },
          select: { bucketName: true, providerConnectionId: true },
        }),
        this.database.bucketConnection.findFirst({
          where: { id: item.targetBucketConnectionId, organizationId: item.organizationId },
          select: { bucketName: true, providerConnectionId: true },
        }),
      ]);
      if (!sourceBucket || !targetBucket) throw new Error("MIGRATION_BUCKET_NOT_FOUND");
      const [sourceAdapter, resolvedTargetAdapter] = await Promise.all([
        this.providerService.adapterFor(item.organizationId, sourceBucket.providerConnectionId),
        this.providerService.adapterFor(item.organizationId, targetBucket.providerConnectionId),
      ]);
      targetAdapter = resolvedTargetAdapter;
      targetBucketName = targetBucket.bucketName;
      const source = await sourceAdapter.getObject(sourceBucket.bucketName, item.sourcePhysicalKey);
      sourceBody = source.body;
      assertSourceFingerprint(item, source.metadata);
      const contentLengthBytes = safeContentLength(item.sizeBytes);
      await targetAdapter.putObject(
        targetBucket.bucketName,
        item.targetPhysicalKey,
        source.body,
        source.metadata.contentType,
        contentLengthBytes,
      );
      targetCopied = true;
      const sourceAfterCopy = await sourceAdapter.headObject(
        sourceBucket.bucketName,
        item.sourcePhysicalKey,
      );
      assertSameSourceVersion(source.metadata, sourceAfterCopy);
      const destination = await targetAdapter.headObject(targetBucket.bucketName, item.targetPhysicalKey);
      if (destination.sizeBytes !== item.sizeBytes) throw new Error("MIGRATION_SIZE_MISMATCH");
      if (
        item.checksum &&
        destination.checksumSha256 &&
        item.checksum !== destination.checksumSha256 &&
        item.checksum !== `sha256:${destination.checksumSha256}`
      ) {
        throw new Error("MIGRATION_CHECKSUM_MISMATCH");
      }
      const switched = await this.switchLocation(item, previousState === "FAILED");
      if (!switched) {
        await targetAdapter.deleteObject(targetBucket.bucketName, item.targetPhysicalKey).catch(() => undefined);
      }
      return switched ? "completed" : "skipped";
    } catch (error) {
      sourceBody?.destroy();
      if (targetCopied && targetAdapter && targetBucketName) {
        await targetAdapter.deleteObject(targetBucketName, item.targetPhysicalKey).catch(() => undefined);
      }
      await this.markFailed(item.id, item.organizationId, previousState, error, retryDelayMs);
      return "failed";
    }
  }

  private async providerKeysForItem(item: {
    organizationId: string;
    sourceBucketConnectionId: string;
    targetBucketConnectionId: string;
  }): Promise<string[]> {
    const fallback = [item.sourceBucketConnectionId, item.targetBucketConnectionId];
    const findMany = this.database.bucketConnection.findMany;
    if (typeof findMany !== "function") return fallback;
    const buckets = await findMany({
      where: {
        organizationId: item.organizationId,
        id: { in: [...new Set(fallback)] },
      },
      select: { id: true, providerConnectionId: true },
    });
    const providerKeys = fallback.map(
      (bucketId) => buckets.find((bucket) => bucket.id === bucketId)?.providerConnectionId ?? bucketId,
    );
    return [...new Set(providerKeys)];
  }

  private async reconcileCancelledItems(batchSize: number): Promise<number> {
    const items = await this.database.migrationItem.findMany({
      where: {
        migrationRun: { state: "CANCELLED" },
        state: { in: ["PENDING", "COPYING", "FAILED"] },
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
    });
    let failed = 0;
    for (const item of items) {
      try {
        const bucket = await this.database.bucketConnection.findFirst({
          where: { id: item.targetBucketConnectionId, organizationId: item.organizationId },
          select: { bucketName: true, providerConnectionId: true },
        });
        if (bucket) {
          const adapter = await this.providerService.adapterFor(item.organizationId, bucket.providerConnectionId);
          await adapter.deleteObject(bucket.bucketName, item.targetPhysicalKey);
        }
        await this.database.$transaction(async (transaction) => {
          const changed = await transaction.migrationItem.updateMany({
            where: { id: item.id, organizationId: item.organizationId, state: { in: ["PENDING", "COPYING", "FAILED"] } },
            data: { state: "SKIPPED", lastError: "CANCELLED" },
          });
          if (changed.count === 1) {
            await transaction.migrationRun.updateMany({
              where: { id: item.migrationRunId, organizationId: item.organizationId },
              data: { completedItems: { increment: 1 } },
            });
          }
        });
      } catch {
        failed += 1;
      }
    }
    return failed;
  }

  private async claim(id: string, organizationId: string, previousState: string): Promise<boolean> {
    const changed = await this.database.migrationItem.updateMany({
      where: {
        id,
        organizationId,
        state: previousState as "PENDING" | "FAILED" | "COPYING",
        migrationRun: { state: "RUNNING" },
      },
      data: { state: "COPYING", attempts: { increment: 1 }, lastError: null },
    });
    return changed.count === 1;
  }

  private async switchLocation(item: {
    id: string;
    organizationId: string;
    migrationRunId: string;
    objectRecordId: string;
    sourceLocationId: string;
    targetBucketConnectionId: string;
    targetPhysicalKey: string;
    sizeBytes: bigint;
  }, wasPreviouslyFailed: boolean): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const run = await transaction.migrationRun.findFirst({
        where: { id: item.migrationRunId, organizationId: item.organizationId, state: "RUNNING" },
        select: { id: true },
      });
      if (!run) {
        await transaction.migrationItem.updateMany({
          where: { id: item.id, organizationId: item.organizationId, state: "COPYING" },
          data: { state: "SKIPPED", lastError: "RUN_NOT_RUNNING" },
        });
        return false;
      }
      const object = await transaction.objectRecord.findFirst({
        where: {
          id: item.objectRecordId,
          organizationId: item.organizationId,
          state: "AVAILABLE",
          activeObjectLocationId: item.sourceLocationId,
        },
      });
      if (!object) {
        await transaction.migrationItem.updateMany({
          where: { id: item.id, organizationId: item.organizationId, state: "COPYING" },
          data: { state: "SKIPPED", lastError: "SOURCE_CHANGED" },
        });
        await transaction.migrationRun.update({
          where: { id: item.migrationRunId },
          data: { completedItems: { increment: 1 }, ...(wasPreviouslyFailed ? { failedItems: { decrement: 1 } } : {}) },
        });
        return false;
      }
      const target = await transaction.objectLocation.upsert({
        where: {
          objectRecordId_bucketConnectionId_physicalKey: {
            objectRecordId: item.objectRecordId,
            bucketConnectionId: item.targetBucketConnectionId,
            physicalKey: item.targetPhysicalKey,
          },
        },
        create: {
          id: randomUUID(),
          organizationId: item.organizationId,
          objectRecordId: item.objectRecordId,
          bucketConnectionId: item.targetBucketConnectionId,
          physicalKey: item.targetPhysicalKey,
          state: "ACTIVE",
          verifiedAt: new Date(),
        },
        update: { state: "ACTIVE", verifiedAt: new Date() },
      });
      await transaction.objectLocation.updateMany({
        where: { id: item.sourceLocationId, organizationId: item.organizationId, state: "ACTIVE" },
        data: { state: "RETAINED" },
      });
      const pointerChanged = await transaction.objectRecord.updateMany({
        where: { id: item.objectRecordId, organizationId: item.organizationId, activeObjectLocationId: item.sourceLocationId, state: "AVAILABLE" },
        data: { activeObjectLocationId: target.id },
      });
      if (pointerChanged.count !== 1) {
        await transaction.objectLocation.updateMany({
          where: { id: target.id, organizationId: item.organizationId, state: "ACTIVE" },
          data: { state: "RETAINED" },
        });
        await transaction.migrationItem.updateMany({
          where: { id: item.id, organizationId: item.organizationId, state: "COPYING" },
          data: { state: "SKIPPED", lastError: "SOURCE_CHANGED" },
        });
        await transaction.migrationRun.update({
          where: { id: item.migrationRunId },
          data: { completedItems: { increment: 1 }, ...(wasPreviouslyFailed ? { failedItems: { decrement: 1 } } : {}) },
        });
        return false;
      }
      const changed = await transaction.migrationItem.updateMany({
        where: { id: item.id, organizationId: item.organizationId, state: "COPYING" },
        data: { state: "COMPLETED", lastError: null, nextAttemptAt: null },
      });
      if (changed.count !== 1) return false;
      await transaction.migrationRun.update({
        where: { id: item.migrationRunId },
        data: { completedItems: { increment: 1 }, ...(wasPreviouslyFailed ? { failedItems: { decrement: 1 } } : {}) },
      });
      await transaction.activityLog.create({
        data: {
          organizationId: item.organizationId,
          action: "migrations.item_completed",
          entityType: "MigrationItem",
          entityId: item.id,
          requestId: "worker",
          metadata: { objectRecordId: item.objectRecordId, targetLocationId: target.id },
        },
      });
      return true;
    });
  }

  private async markFailed(
    id: string,
    organizationId: string,
    previousState: string,
    error: unknown,
    retryDelayMs: number,
  ): Promise<void> {
    const message = migrationErrorCode(error);
    const nextAttemptAt = new Date(Date.now() + retryDelayMs);
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.migrationItem.updateMany({
        where: { id, organizationId, state: "COPYING" },
        data: { state: "FAILED", lastError: message, nextAttemptAt },
      });
      if (changed.count !== 1) return;
      await transaction.migrationRun.updateMany({
        where: { items: { some: { id, organizationId } } },
        data: {
          lastError: message,
          ...(previousState === "FAILED" ? {} : { failedItems: { increment: 1 } }),
        },
      });
    });
  }

  private async completeEmptyRuns(): Promise<void> {
    await this.database.migrationRun.updateMany({
      where: { state: "RUNNING", totalItems: 0 },
      data: { state: "COMPLETED", completedAt: new Date() },
    });
    const runs = await this.database.migrationRun.findMany({
      where: { state: "RUNNING", totalItems: { gt: 0 } },
      select: { id: true, totalItems: true, completedItems: true },
    });
    for (const run of runs) {
      if (run.completedItems !== run.totalItems) continue;
      await this.database.migrationRun.updateMany({
        where: { id: run.id, state: "RUNNING", completedItems: run.totalItems },
        data: { state: "COMPLETED", completedAt: new Date() },
      });
    }
  }

  private safeBatchSize(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError("batchSize must be an integer from 1 to 100");
    return value;
  }

  private safeConcurrency(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      throw new RangeError("maxConcurrentPerProvider must be an integer from 1 to 20");
    }
    return value;
  }

  private safeRetryDelay(value: number): number {
    if (!Number.isInteger(value) || value < 1_000 || value > 86_400_000) {
      throw new RangeError("retryDelayMs must be an integer from 1000 to 86400000");
    }
    return value;
  }
}

export function migrationErrorCode(error: unknown): string {
  if (error instanceof Error && SAFE_MIGRATION_ERRORS.has(error.message)) {
    return error.message;
  }

  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
      : undefined;
  if (status === 404) return "PROVIDER_OBJECT_NOT_FOUND";
  if (status === 408 || status === 429) return "PROVIDER_RETRYABLE";
  if (typeof status === "number" && status >= 500) return "PROVIDER_UNAVAILABLE";
  return "MIGRATION_FAILED";
}

function assertSourceFingerprint(
  item: { sizeBytes: bigint; checksum: string | null; sourceEtag: string | null; sourceLastModified: Date | null },
  metadata: { sizeBytes: bigint; checksumSha256?: string; etag?: string; lastModified?: Date },
): void {
  if (metadata.sizeBytes !== item.sizeBytes) throw new Error("SOURCE_CHANGED");
  if (item.sourceEtag && (!metadata.etag || item.sourceEtag !== metadata.etag)) {
    throw new Error("SOURCE_CHANGED");
  }
  if (
    item.sourceLastModified &&
    (!metadata.lastModified || item.sourceLastModified.getTime() !== metadata.lastModified.getTime())
  ) {
    throw new Error("SOURCE_CHANGED");
  }
  if (
    item.checksum &&
    metadata.checksumSha256 &&
    item.checksum !== metadata.checksumSha256 &&
    item.checksum !== `sha256:${metadata.checksumSha256}`
  ) {
    throw new Error("SOURCE_CHANGED");
  }
}

function assertSameSourceVersion(
  before: { sizeBytes: bigint; checksumSha256?: string; etag?: string; lastModified?: Date },
  after: { sizeBytes: bigint; checksumSha256?: string; etag?: string; lastModified?: Date },
): void {
  if (before.sizeBytes !== after.sizeBytes) throw new Error("SOURCE_CHANGED");
  if (before.etag && (!after.etag || before.etag !== after.etag)) throw new Error("SOURCE_CHANGED");
  if (
    before.lastModified &&
    (!after.lastModified || before.lastModified.getTime() !== after.lastModified.getTime())
  ) {
    throw new Error("SOURCE_CHANGED");
  }
  if (
    before.checksumSha256 &&
    after.checksumSha256 &&
    before.checksumSha256 !== after.checksumSha256
  ) {
    throw new Error("SOURCE_CHANGED");
  }
}

function safeContentLength(sizeBytes: bigint): number {
  if (sizeBytes < 0n || sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("MIGRATION_SIZE_UNSUPPORTED");
  }
  return Number(sizeBytes);
}
