import { randomUUID } from "node:crypto";
import { Readable, type Readable as ReadableStream } from "node:stream";

import { Prisma, type PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";
import type { ObjectListQuery } from "@mosp/shared";

import type { ProviderConnectionService } from "../providers/service.js";
import type { UsageService } from "../usage/service.js";
import type { ObjectSummary } from "../storage/object-service.js";
import { PlacementService } from "../storage/placement-service.js";
import { DEFAULT_PROXY_TRANSFER_CONFIG, type ProxyTransferConfig } from "../storage/transfer.js";

const FOLDER_MARKER = ".mosp-folder";

export interface ObjectExplorerNamespace {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export class ObjectExplorerNamespaceNotFound extends Error {}
export class ObjectExplorerObjectNotFound extends Error {}
export class ObjectExplorerDownloadUnavailable extends Error {}
export class ObjectExplorerDeleteUnavailable extends Error {}
export class ObjectExplorerUploadUnavailable extends Error {}
export class ObjectExplorerUploadTooLarge extends Error {}
export class ObjectExplorerUploadQuotaExceeded extends Error {}
export class ObjectExplorerUploadConflict extends Error {}
export class ObjectExplorerUploadTargetUnavailable extends Error {}

export class ObjectExplorerService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly providerService?: ProviderConnectionService,
    private readonly usageService?: UsageService,
    private readonly placementService?: PlacementService,
    private readonly proxyTransferConfig: ProxyTransferConfig = DEFAULT_PROXY_TRANSFER_CONFIG,
  ) {}

  public async listNamespaces(organizationId: string): Promise<ObjectExplorerNamespace[]> {
    const namespaces = await this.database.virtualNamespace.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, status: true },
    });
    return namespaces;
  }

  public async list(
    organizationId: string,
    namespaceSlug: string,
    query: ObjectListQuery,
  ): Promise<ObjectSummary[]> {
    const namespace = await this.resolveNamespace(organizationId, namespaceSlug);
    const records = await this.database.objectRecord.findMany({
      where: {
        organizationId,
        namespaceId: namespace.id,
        state: "AVAILABLE",
        ...(query.prefix !== undefined ? { logicalKey: { startsWith: query.prefix } } : {}),
      },
      orderBy: { logicalKey: "asc" },
      take: query.limit,
      include: { activeObjectLocation: { select: { state: true, etag: true } } },
    });

    return records
      .filter((record) => record.activeObjectLocation?.state === "ACTIVE")
      .filter((record) => !this.isFolderMarker(record.logicalKey))
      .map((record) => this.toSummary(record));
  }

  public async listFolders(
    organizationId: string,
    namespaceSlug: string,
    prefix: string,
  ): Promise<string[]> {
    const namespace = await this.resolveNamespace(organizationId, namespaceSlug);
    const records = await this.database.objectRecord.findMany({
      where: {
        organizationId,
        namespaceId: namespace.id,
        state: "AVAILABLE",
        logicalKey: { startsWith: prefix },
      },
      orderBy: { logicalKey: "asc" },
      take: 1000,
      select: { logicalKey: true, activeObjectLocation: { select: { state: true } } },
    });
    return records
      .filter((record) => record.activeObjectLocation?.state === "ACTIVE")
      .filter((record) => this.isFolderMarker(record.logicalKey))
      .map((record) => record.logicalKey.slice(0, -FOLDER_MARKER.length))
      .filter((folder) => folder.startsWith(prefix));
  }

  public async createFolder(
    organizationId: string,
    namespaceSlug: string,
    prefix: string,
    actorId: string,
    requestId: string,
  ): Promise<{ prefix: string }> {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const markerKey = `${normalizedPrefix}${FOLDER_MARKER}`;
    const existing = await this.database.objectRecord.findFirst({
      where: { organizationId, logicalKey: markerKey, state: "AVAILABLE" },
      select: { id: true },
    });
    if (existing) return { prefix: normalizedPrefix };
    await this.upload(
      organizationId,
      namespaceSlug,
      markerKey,
      Readable.from([]),
      0n,
      "application/x-mosp-folder",
      actorId,
      requestId,
    );
    return { prefix: normalizedPrefix };
  }

  public async upload(
    organizationId: string,
    namespaceSlug: string,
    key: string,
    body: ReadableStream,
    sizeBytes: bigint,
    contentType: string | null,
    actorId: string,
    requestId: string,
  ): Promise<ObjectSummary> {
    if (!this.providerService || !this.placementService) {
      throw new ObjectExplorerUploadUnavailable();
    }
    if (sizeBytes < 0n || sizeBytes > this.proxyTransferConfig.maxObjectBytes) {
      throw new ObjectExplorerUploadTooLarge();
    }
    const namespace = await this.database.virtualNamespace.findFirst({
      where: { organizationId, slug: namespaceSlug, status: "ACTIVE" },
      select: { id: true, quotaBytes: true, maxObjectSizeBytes: true },
    });
    if (!namespace) throw new ObjectExplorerNamespaceNotFound();
    if (namespace.maxObjectSizeBytes !== null && sizeBytes > namespace.maxObjectSizeBytes) {
      throw new ObjectExplorerUploadTooLarge();
    }
    const existing = await this.database.objectRecord.findFirst({
      where: { organizationId, namespaceId: namespace.id, logicalKey: key, state: "AVAILABLE" },
      select: { id: true },
    });
    if (existing) throw new ObjectExplorerUploadConflict();

    const target = await this.placementService.selectTarget(organizationId, namespace.id, sizeBytes);
    if (!target) throw new ObjectExplorerUploadTargetUnavailable();
    const physicalKey = `objects/${namespace.id}/${randomUUID()}`;
    await this.database.$transaction(async (transaction) => {
      await this.lockUsageCounter(transaction, organizationId, namespace.id);
      const counter = await transaction.usageCounter.findUniqueOrThrow({
        where: { organizationId_namespaceId: { organizationId, namespaceId: namespace.id } },
      });
      if (counter.usedBytes + counter.reservedBytes + sizeBytes > namespace.quotaBytes) {
        throw new ObjectExplorerUploadQuotaExceeded();
      }
      if (!(await this.placementService!.assertTargetCapacity(
        transaction,
        organizationId,
        namespace.id,
        target.id,
        sizeBytes,
      ))) {
        throw new ObjectExplorerUploadTargetUnavailable();
      }
      await transaction.usageCounter.update({
        where: { organizationId_namespaceId: { organizationId, namespaceId: namespace.id } },
        data: { reservedBytes: { increment: sizeBytes } },
      });
    });

    let metadata: Awaited<ReturnType<S3ProviderAdapter["headObject"]>>;
    let adapter: S3ProviderAdapter | undefined;
    try {
      adapter = await this.providerService.adapterFor(
        organizationId,
        target.bucketConnection.providerConnectionId,
        this.proxyTransferConfig.timeoutMs,
      );
      await adapter.putObject(
        target.bucketConnection.bucketName,
        physicalKey,
        body,
        contentType,
        Number(sizeBytes),
      );
      metadata = await adapter.headObject(target.bucketConnection.bucketName, physicalKey);
      if (metadata.sizeBytes !== sizeBytes) throw new Error("PROVIDER_SIZE_MISMATCH");
    } catch {
      await this.releaseReservation(organizationId, namespace.id, sizeBytes);
      await adapter?.deleteObject(target.bucketConnection.bucketName, physicalKey).catch(() => undefined);
      throw new ObjectExplorerUploadUnavailable();
    }

    const objectRecordId = randomUUID();
    const locationId = randomUUID();
    try {
      await this.database.$transaction(async (transaction) => {
        await transaction.objectRecord.create({
          data: {
            id: objectRecordId,
            organizationId,
            namespaceId: namespace.id,
            logicalKey: key,
            state: "PENDING",
            sizeBytes: metadata.sizeBytes,
            contentType: contentType ?? metadata.contentType ?? null,
            checksum: metadata.checksumSha256 ? `sha256:${metadata.checksumSha256}` : null,
          },
        });
        await transaction.objectLocation.create({
          data: {
            id: locationId,
            organizationId,
            objectRecordId,
            bucketConnectionId: target.bucketConnection.id,
            physicalKey,
            state: "ACTIVE",
            etag: metadata.etag ?? null,
            providerLastModified: metadata.lastModified ?? null,
            verifiedAt: new Date(),
          },
        });
        await transaction.objectRecord.update({
          where: { id: objectRecordId },
          data: { state: "AVAILABLE", activeObjectLocationId: locationId },
        });
        await this.lockUsageCounter(transaction, organizationId, namespace.id);
        await transaction.usageCounter.update({
          where: { organizationId_namespaceId: { organizationId, namespaceId: namespace.id } },
          data: {
            reservedBytes: { decrement: sizeBytes },
            usedBytes: { increment: metadata.sizeBytes },
            objectCount: { increment: 1n },
          },
        });
        await transaction.activityLog.create({
          data: {
            organizationId,
            actorId,
            action: "objects.upload",
            entityType: "ObjectRecord",
            entityId: objectRecordId,
            requestId,
            metadata: { namespaceId: namespace.id, key, sizeBytes: metadata.sizeBytes.toString(), source: "admin_object_explorer" },
          },
        });
      });
    } catch {
      await this.releaseReservation(organizationId, namespace.id, sizeBytes).catch(() => undefined);
      try {
        const adapter = await this.providerService.adapterFor(organizationId, target.bucketConnection.providerConnectionId);
        await adapter.deleteObject(target.bucketConnection.bucketName, physicalKey);
      } catch {
        // The object remains unindexed and is cleaned up by provider reconciliation.
      }
      throw new ObjectExplorerUploadUnavailable();
    }

    return {
      key,
      sizeBytes: metadata.sizeBytes.toString(),
      contentType: contentType ?? metadata.contentType ?? null,
      checksum: metadata.checksumSha256 ? `sha256:${metadata.checksumSha256}` : null,
      modifiedAt: (metadata.lastModified ?? new Date()).toISOString(),
      etag: metadata.etag ?? null,
    };
  }

  public async presignDownload(
    organizationId: string,
    namespaceSlug: string,
    key: string,
  ): Promise<{ expiresAt: string; url: string }> {
    if (!this.providerService) throw new ObjectExplorerDownloadUnavailable();
    const namespace = await this.resolveNamespace(organizationId, namespaceSlug);
    const record = await this.database.objectRecord.findFirst({
      where: { organizationId, namespaceId: namespace.id, logicalKey: key, state: "AVAILABLE" },
      include: {
        activeObjectLocation: {
          select: {
            state: true,
            physicalKey: true,
            bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
          },
        },
      },
    });
    const location = record?.activeObjectLocation;
    if (!record || !location || location.state !== "ACTIVE") {
      throw new ObjectExplorerObjectNotFound();
    }

    try {
      const adapter = await this.providerService.adapterFor(
        organizationId,
        location.bucketConnection.providerConnectionId,
      );
      const transfer = await adapter.createPresignedDownload(
        location.bucketConnection.bucketName,
        location.physicalKey,
      );
      await this.usageService?.recordEgress(organizationId, namespace.id, record.sizeBytes);
      return { url: transfer.url, expiresAt: transfer.expiresAt.toISOString() };
    } catch {
      throw new ObjectExplorerDownloadUnavailable();
    }
  }

  public async delete(
    organizationId: string,
    namespaceSlug: string,
    key: string,
    actorId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.providerService) throw new ObjectExplorerDeleteUnavailable();
    const namespace = await this.resolveNamespace(organizationId, namespaceSlug);
    const record = await this.database.objectRecord.findFirst({
      where: { organizationId, namespaceId: namespace.id, logicalKey: key, state: "AVAILABLE" },
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
    const location = record?.activeObjectLocation;
    if (!record || !location || location.state !== "ACTIVE") {
      throw new ObjectExplorerObjectNotFound();
    }

    await this.database.$transaction(async (transaction) => {
      const claimed = await transaction.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId,
          namespaceId: namespace.id,
          state: "AVAILABLE",
          activeObjectLocationId: location.id,
        },
        data: { state: "DELETING" },
      });
      if (claimed.count !== 1) throw new ObjectExplorerObjectNotFound();
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId,
          action: "objects.delete_requested",
          entityType: "ObjectRecord",
          entityId: record.id,
          requestId,
          metadata: { namespaceId: namespace.id, key, source: "admin_object_explorer" },
        },
      });
    });

    try {
      const adapter = await this.providerService.adapterFor(
        organizationId,
        location.bucketConnection.providerConnectionId,
      );
      await adapter.deleteObject(location.bucketConnection.bucketName, location.physicalKey);
    } catch {
      await this.database.objectRecord.updateMany({
        where: { id: record.id, organizationId, state: "DELETING" },
        data: { state: "AVAILABLE" },
      });
      throw new ObjectExplorerDeleteUnavailable();
    }

    await this.database.$transaction(async (transaction) => {
      const finalized = await transaction.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId,
          namespaceId: namespace.id,
          state: "DELETING",
          activeObjectLocationId: location.id,
        },
        data: { state: "DELETED", activeObjectLocationId: null },
      });
      if (finalized.count !== 1) throw new ObjectExplorerObjectNotFound();
      await transaction.objectLocation.updateMany({
        where: { id: location.id, organizationId, state: "ACTIVE" },
        data: { state: "DELETED" },
      });
      await this.lockUsageCounter(transaction, organizationId, namespace.id);
      await transaction.usageCounter.update({
        where: { organizationId_namespaceId: { organizationId, namespaceId: namespace.id } },
        data: { usedBytes: { decrement: record.sizeBytes }, objectCount: { decrement: 1n } },
      });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId,
          action: "objects.delete",
          entityType: "ObjectRecord",
          entityId: record.id,
          requestId,
          metadata: {
            namespaceId: namespace.id,
            key,
            source: "admin_object_explorer",
            sizeBytes: record.sizeBytes.toString(),
          },
        },
      });
    });
  }

  private async resolveNamespace(
    organizationId: string,
    namespaceSlug: string,
  ): Promise<{ id: string; status: string }> {
    const namespace = await this.database.virtualNamespace.findFirst({
      where: { organizationId, slug: namespaceSlug },
      select: { id: true, status: true },
    });
    if (!namespace || namespace.status !== "ACTIVE") {
      throw new ObjectExplorerNamespaceNotFound();
    }
    return namespace;
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

  private async releaseReservation(
    organizationId: string,
    namespaceId: string,
    sizeBytes: bigint,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await this.lockUsageCounter(transaction, organizationId, namespaceId);
      await transaction.usageCounter.update({
        where: { organizationId_namespaceId: { organizationId, namespaceId } },
        data: { reservedBytes: { decrement: sizeBytes } },
      });
    });
  }

  private isFolderMarker(key: string): boolean {
    return key.endsWith(`/${FOLDER_MARKER}`);
  }

  private toSummary(record: {
    logicalKey: string;
    sizeBytes: bigint;
    contentType: string | null;
    checksum: string | null;
    modifiedAt: Date;
    activeObjectLocation: { state: string; etag: string | null } | null;
  }): ObjectSummary {
    return {
      key: record.logicalKey,
      sizeBytes: record.sizeBytes.toString(),
      contentType: record.contentType,
      checksum: record.checksum,
      modifiedAt: record.modifiedAt.toISOString(),
      etag: record.activeObjectLocation?.etag ?? null,
    };
  }
}
