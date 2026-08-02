import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@mosp/db";
import type { ProviderConnectionService } from "../providers/service.js";
import type { ObjectListQuery } from "@mosp/shared";

import {
  type ApiCredentialIdentity,
} from "../auth/api-credential.js";
import { FolderGrantService } from "../folder-grants/service.js";
import type { UsageService } from "../usage/service.js";
import {
  DEFAULT_PROXY_TRANSFER_CONFIG,
  type ProxyTransferConfig,
} from "./transfer.js";

export interface ObjectSummary {
  checksum: string | null;
  contentType: string | null;
  etag: string | null;
  key: string;
  modifiedAt: string;
  sizeBytes: string;
}

export class StorageObjectNotFound extends Error {}
export class StorageNamespaceNotFound extends Error {}
export class StorageDownloadUnavailable extends Error {}
export class StorageDeleteUnavailable extends Error {}

export class ObjectIndexService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly folderGrantService: FolderGrantService,
    private readonly providerService?: ProviderConnectionService,
    private readonly usageService?: UsageService,
    private readonly proxyTransferConfig: ProxyTransferConfig = DEFAULT_PROXY_TRANSFER_CONFIG,
  ) {}

  public async resolveNamespace(
    organizationId: string,
    namespaceSlug: string,
  ): Promise<{ id: string; status: string } | null> {
    return this.database.virtualNamespace.findFirst({
      where: { organizationId, slug: namespaceSlug },
      select: { id: true, status: true },
    });
  }

  public async list(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    query: ObjectListQuery,
  ): Promise<ObjectSummary[]> {
    const namespace = await this.resolveNamespace(identity.organizationId, namespaceSlug);
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }

    if (
      query.prefix !== undefined &&
      !(await this.folderGrantService.canAccess({
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        principalType: identity.principalType,
        principalId: identity.principalId,
        action: "list",
        key: query.prefix,
      }))
    ) {
      return [];
    }

    const records = await this.database.objectRecord.findMany({
      where: {
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        state: "AVAILABLE",
        ...(query.prefix !== undefined ? { logicalKey: { startsWith: query.prefix } } : {}),
      },
      orderBy: { logicalKey: "asc" },
      take: query.limit,
      include: {
        activeObjectLocation: {
          select: { state: true, etag: true },
        },
      },
    });

    const allowed: ObjectSummary[] = [];
    for (const record of records) {
      if (!record.activeObjectLocation || record.activeObjectLocation.state !== "ACTIVE") {
        continue;
      }
      const canList = await this.folderGrantService.canAccess({
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        principalType: identity.principalType,
        principalId: identity.principalId,
        action: "list",
        key: record.logicalKey,
      });
      if (!canList) continue;
      allowed.push(this.toSummary(record));
    }
    return allowed;
  }

  public async head(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    key: string,
  ): Promise<ObjectSummary> {
    const namespace = await this.resolveNamespace(identity.organizationId, namespaceSlug);
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }

    const record = await this.database.objectRecord.findFirst({
      where: {
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        logicalKey: key,
        state: "AVAILABLE",
      },
      include: {
        activeObjectLocation: {
          select: { state: true, etag: true },
        },
      },
    });
    if (
      !record ||
      !record.activeObjectLocation ||
      record.activeObjectLocation.state !== "ACTIVE"
    ) {
      throw new StorageObjectNotFound();
    }

    const canRead = await this.folderGrantService.canAccess({
      organizationId: identity.organizationId,
      namespaceId: namespace.id,
      principalType: identity.principalType,
      principalId: identity.principalId,
      action: "read",
      key,
    });
    if (!canRead) throw new StorageObjectNotFound();
    return this.toSummary(record);
  }

  public async presignDownload(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    key: string,
  ): Promise<{ expiresAt: string; url: string }> {
    if (!this.providerService) throw new StorageDownloadUnavailable();
    const namespace = await this.resolveNamespace(identity.organizationId, namespaceSlug);
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }
    const record = await this.database.objectRecord.findFirst({
      where: { organizationId: identity.organizationId, namespaceId: namespace.id, logicalKey: key, state: "AVAILABLE" },
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
    const activeLocation = record?.activeObjectLocation;
    if (!record || !activeLocation || activeLocation.state !== "ACTIVE") {
      throw new StorageObjectNotFound();
    }
    const canRead = await this.folderGrantService.canAccess({
      organizationId: identity.organizationId,
      namespaceId: namespace.id,
      principalType: identity.principalType,
      principalId: identity.principalId,
      action: "read",
      key,
    });
    if (!canRead) throw new StorageObjectNotFound();
    try {
      const adapter = await this.providerService.adapterFor(
        identity.organizationId,
        activeLocation.bucketConnection.providerConnectionId,
      );
      const transfer = await adapter.createPresignedDownload(
        activeLocation.bucketConnection.bucketName,
        activeLocation.physicalKey,
      );
      await this.usageService?.recordEgress(
        identity.organizationId,
        namespace.id,
        record.sizeBytes,
      );
      return { url: transfer.url, expiresAt: transfer.expiresAt.toISOString() };
    } catch {
      throw new StorageDownloadUnavailable();
    }
  }

  public async getTransferMode(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
  ): Promise<"DIRECT" | "PROXIED"> {
    const namespace = await this.database.virtualNamespace.findFirst({
      where: { organizationId: identity.organizationId, slug: namespaceSlug },
      select: { id: true, status: true, defaultTransferMode: true },
    });
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }
    return namespace.defaultTransferMode;
  }

  public async proxyDownload(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    key: string,
    abortSignal?: AbortSignal,
  ) {
    if (!this.providerService) throw new StorageDownloadUnavailable();
    const namespace = await this.resolveNamespace(identity.organizationId, namespaceSlug);
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }
    const record = await this.database.objectRecord.findFirst({
      where: { organizationId: identity.organizationId, namespaceId: namespace.id, logicalKey: key, state: "AVAILABLE" },
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
    const activeLocation = record?.activeObjectLocation;
    if (!record || !activeLocation || activeLocation.state !== "ACTIVE") {
      throw new StorageObjectNotFound();
    }
    const canRead = await this.folderGrantService.canAccess({
      organizationId: identity.organizationId,
      namespaceId: namespace.id,
      principalType: identity.principalType,
      principalId: identity.principalId,
      action: "read",
      key,
    });
    if (!canRead) throw new StorageObjectNotFound();
    try {
      const adapter = await this.providerService.adapterFor(
        identity.organizationId,
        activeLocation.bucketConnection.providerConnectionId,
        this.proxyTransferConfig.timeoutMs,
      );
      const transfer = await adapter.getObject(
        activeLocation.bucketConnection.bucketName,
        activeLocation.physicalKey,
        abortSignal,
      );
      if (transfer.metadata.sizeBytes !== record.sizeBytes) {
        transfer.body.destroy();
        throw new Error("PROVIDER_SIZE_MISMATCH");
      }
      return { namespaceId: namespace.id, ...transfer };
    } catch {
      throw new StorageDownloadUnavailable();
    }
  }

  public async delete(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    key: string,
    requestId: string,
  ): Promise<void> {
    if (!this.providerService) throw new StorageDeleteUnavailable();
    const namespace = await this.resolveNamespace(identity.organizationId, namespaceSlug);
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }

    const record = await this.database.objectRecord.findFirst({
      where: {
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        logicalKey: key,
        state: "AVAILABLE",
      },
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
    const activeLocation = record?.activeObjectLocation;
    if (!record || !activeLocation || activeLocation.state !== "ACTIVE") {
      throw new StorageObjectNotFound();
    }

    const canDelete = await this.folderGrantService.canAccess({
      organizationId: identity.organizationId,
      namespaceId: namespace.id,
      principalType: identity.principalType,
      principalId: identity.principalId,
      action: "delete",
      key,
    });
    if (!canDelete) throw new StorageObjectNotFound();

    await this.database.$transaction(async (transaction) => {
      const claimed = await transaction.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId: identity.organizationId,
          namespaceId: namespace.id,
          state: "AVAILABLE",
          activeObjectLocationId: activeLocation.id,
        },
        data: { state: "DELETING" },
      });
      if (claimed.count !== 1) throw new StorageObjectNotFound();
      await transaction.activityLog.create({
        data: {
          organizationId: identity.organizationId,
          action: "objects.delete_requested",
          entityType: "ObjectRecord",
          entityId: record.id,
          requestId,
          metadata: {
            namespaceId: namespace.id,
            key,
            credentialId: identity.credentialId,
          },
        },
      });
    });

    try {
      const adapter = await this.providerService.adapterFor(
        identity.organizationId,
        activeLocation.bucketConnection.providerConnectionId,
      );
      await adapter.deleteObject(
        activeLocation.bucketConnection.bucketName,
        activeLocation.physicalKey,
      );
    } catch {
      await this.database.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId: identity.organizationId,
          state: "DELETING",
        },
        data: { state: "AVAILABLE" },
      });
      throw new StorageDeleteUnavailable();
    }

    await this.database.$transaction(async (transaction) => {
      const finalized = await transaction.objectRecord.updateMany({
        where: {
          id: record.id,
          organizationId: identity.organizationId,
          namespaceId: namespace.id,
          state: "DELETING",
          activeObjectLocationId: activeLocation.id,
        },
        data: { state: "DELETED", activeObjectLocationId: null },
      });
      if (finalized.count !== 1) throw new StorageObjectNotFound();
      await transaction.objectLocation.updateMany({
        where: {
          id: activeLocation.id,
          organizationId: identity.organizationId,
          state: "ACTIVE",
        },
        data: { state: "DELETED" },
      });
      await this.lockUsageCounter(transaction, identity.organizationId, namespace.id);
      await transaction.usageCounter.update({
        where: {
          organizationId_namespaceId: {
            organizationId: identity.organizationId,
            namespaceId: namespace.id,
          },
        },
        data: {
          usedBytes: { decrement: record.sizeBytes },
          objectCount: { decrement: 1n },
        },
      });
      await transaction.activityLog.create({
        data: {
          organizationId: identity.organizationId,
          action: "objects.delete",
          entityType: "ObjectRecord",
          entityId: record.id,
          requestId,
          metadata: {
            namespaceId: namespace.id,
            key,
            credentialId: identity.credentialId,
            sizeBytes: record.sizeBytes.toString(),
          },
        },
      });
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
