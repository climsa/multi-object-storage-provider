import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

export interface UploadReconciliationResult {
  expired: number;
  failed: number;
}

export interface UploadReconciliationOptions {
  batchSize?: number;
  now?: Date;
}

type ReconciliationAdapterResolver = {
  adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter>;
};

export class UploadReconciliationService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly providerService: ReconciliationAdapterResolver,
  ) {}

  public async reconcile(
    options: UploadReconciliationOptions = {},
  ): Promise<UploadReconciliationResult> {
    const now = options.now ?? new Date();
    const batchSize = this.safeBatchSize(options.batchSize ?? 100);
    const sessions = await this.database.uploadSession.findMany({
      where: { state: "INITIATED", expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
      take: batchSize,
      include: {
        bucketConnection: {
          select: { bucketName: true, providerConnectionId: true },
        },
      },
    });

    let expired = 0;
    let failed = 0;
    for (const session of sessions) {
      try {
        const adapter = await this.providerService.adapterFor(
          session.organizationId,
          session.bucketConnection.providerConnectionId,
        );
        await this.deletePhysicalObject(
          adapter,
          session.bucketConnection.bucketName,
          session.physicalKey,
          session.transferMode,
          session.providerUploadId,
          session.providerUploadFinalized,
        );
        const reclaimed = await this.markExpired(session);
        if (reclaimed) expired += 1;
      } catch {
        failed += 1;
      }
    }
    failed += await this.reconcileDeletingObjects(batchSize);
    failed += await this.reconcileRetainedLocations(batchSize);
    await this.pruneTerminalSessions(now, batchSize);
    return { expired, failed };
  }

  private async reconcileDeletingObjects(batchSize: number): Promise<number> {
    const delegate = (this.database as unknown as {
      objectRecord?: { findMany?: unknown };
    }).objectRecord;
    if (typeof delegate?.findMany !== "function") return 0;

    const records = await this.database.objectRecord.findMany({
      where: { state: "DELETING" },
      orderBy: { modifiedAt: "asc" },
      take: batchSize,
      include: {
        activeObjectLocation: {
          select: {
            id: true,
            state: true,
            physicalKey: true,
            bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
          },
        },
      },
    });
    let failed = 0;
    for (const record of records) {
      const location = record.activeObjectLocation;
      if (!location || location.state !== "ACTIVE") {
        // A DELETING record without an active location is safe to close. The
        // usage counter is intentionally not changed because there is no
        // authoritative byte count to reclaim.
        await this.database.objectRecord.updateMany({
          where: { id: record.id, organizationId: record.organizationId, state: "DELETING" },
          data: { state: "DELETED", activeObjectLocationId: null },
        });
        continue;
      }
      try {
        const adapter = await this.providerService.adapterFor(
          record.organizationId,
          location.bucketConnection.providerConnectionId,
        );
        await adapter.deleteObject(location.bucketConnection.bucketName, location.physicalKey);
        await this.finalizeDeletedObject(record, location.id);
      } catch {
        failed += 1;
      }
    }
    return failed;
  }

  private async finalizeDeletedObject(
    record: { id: string; organizationId: string; namespaceId: string; sizeBytes: bigint },
    locationId: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId: record.organizationId,
          namespaceId: record.namespaceId,
          state: "DELETING",
          activeObjectLocationId: locationId,
        },
        data: { state: "DELETED", activeObjectLocationId: null },
      });
      if (changed.count !== 1) return;
      await transaction.objectLocation.updateMany({
        where: { id: locationId, organizationId: record.organizationId, state: "ACTIVE" },
        data: { state: "DELETED" },
      });
      await this.lockUsageCounter(transaction, record.organizationId, record.namespaceId);
      await transaction.usageCounter.update({
        where: {
          organizationId_namespaceId: {
            organizationId: record.organizationId,
            namespaceId: record.namespaceId,
          },
        },
        data: {
          usedBytes: { decrement: record.sizeBytes },
          objectCount: { decrement: 1n },
        },
      });
      await transaction.activityLog.create({
        data: {
          organizationId: record.organizationId,
          action: "objects.delete.reconciled",
          entityType: "ObjectRecord",
          entityId: record.id,
          requestId: "worker",
          metadata: { locationId },
        },
      });
    });
  }

  private async reconcileRetainedLocations(batchSize: number): Promise<number> {
    const delegate = (this.database as unknown as {
      objectLocation?: { findMany?: unknown };
    }).objectLocation;
    if (typeof delegate?.findMany !== "function") return 0;
    const locations = await this.database.objectLocation.findMany({
      where: { state: "RETAINED" },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
      include: {
        bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
      },
    });
    let failed = 0;
    for (const location of locations) {
      try {
        const adapter = await this.providerService.adapterFor(
          location.organizationId,
          location.bucketConnection.providerConnectionId,
        );
        await adapter.deleteObject(location.bucketConnection.bucketName, location.physicalKey);
        await this.database.objectLocation.updateMany({
          where: { id: location.id, organizationId: location.organizationId, state: "RETAINED" },
          data: { state: "DELETED" },
        });
      } catch {
        failed += 1;
      }
    }
    return failed;
  }

  private async deletePhysicalObject(
    adapter: S3ProviderAdapter,
    bucketName: string,
    physicalKey: string,
    transferMode: string,
    providerUploadId: string | null,
    providerUploadFinalized: boolean,
  ): Promise<void> {
    if (transferMode === "MULTIPART" && providerUploadId && !providerUploadFinalized) {
      // A crash can happen after provider completion but before the database
      // flag is committed. HEAD first so a completed object is deleted rather
      // than incorrectly aborted and stranded.
      if (await adapter.objectExists(bucketName, physicalKey)) {
        await adapter.deleteObject(bucketName, physicalKey);
      } else {
        await adapter.abortMultipartUpload(bucketName, physicalKey, providerUploadId);
      }
      return;
    }
    await adapter.deleteObject(bucketName, physicalKey);
  }

  private async markExpired(session: {
    id: string;
    organizationId: string;
    namespaceId: string;
    reservedBytes: bigint;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const changed = await transaction.uploadSession.updateMany({
        where: {
          id: session.id,
          organizationId: session.organizationId,
          namespaceId: session.namespaceId,
          state: "INITIATED",
        },
        data: { state: "EXPIRED" },
      });
      if (changed.count !== 1) return false;

      await this.lockUsageCounter(
        transaction,
        session.organizationId,
        session.namespaceId,
      );
      await transaction.usageCounter.update({
        where: {
          organizationId_namespaceId: {
            organizationId: session.organizationId,
            namespaceId: session.namespaceId,
          },
        },
        data: {
          reservedBytes: { decrement: session.reservedBytes },
          activeUploadCount: { decrement: 1 },
        },
      });
      return true;
    });
  }

  private async lockUsageCounter(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    namespaceId: string,
  ): Promise<void> {
    await transaction.usageCounter.upsert({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      create: { id: randomUUID(), organizationId, namespaceId },
      update: {},
    });
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "UsageCounter" WHERE "organizationId" = ${organizationId} AND "namespaceId" = ${namespaceId} FOR UPDATE`,
    );
  }

  private safeBatchSize(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new RangeError("batchSize must be an integer from 1 to 1000");
    }
    return value;
  }

  private async pruneTerminalSessions(now: Date, batchSize: number): Promise<void> {
    if (typeof this.database.uploadSession.deleteMany !== "function") return;

    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const terminal = await this.database.uploadSession.findMany({
      where: {
        state: { in: ["ABORTED", "EXPIRED", "COMPLETED"] },
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: "asc" },
      take: batchSize,
      select: { id: true },
    });
    if (terminal.length === 0) return;
    await this.database.uploadSession.deleteMany({ where: { id: { in: terminal.map((session) => session.id) } } });
  }
}
