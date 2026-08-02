import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@mosp/db";
import type {
  BucketConnectionStatusUpdateRequest,
  BucketImportRequest,
} from "@mosp/shared";

import { ProviderConnectionService } from "../providers/service.js";

export interface BucketActionMetadata {
  actorId: string;
  requestId: string;
}

export interface BucketConnectionSummary {
  bucketName: string;
  createdAt: string;
  id: string;
  providerConnectionId: string;
  status: string;
}

export class BucketConnectionAccessError extends Error {}
export class BucketConnectionNotFound extends Error {}
export class BucketConnectionMustBeDisabled extends Error {}

export class BucketConnectionService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly providerService: ProviderConnectionService,
  ) {}

  public async listAccessibleBuckets(
    organizationId: string,
    providerConnectionId: string,
  ): Promise<string[]> {
    const adapter = await this.providerService.adapterFor(
      organizationId,
      providerConnectionId,
    );

    try {
      const result = await adapter.testConnection();
      return result.bucketNames;
    } catch {
      throw new BucketConnectionAccessError("BUCKET_LIST_FAILED");
    }
  }

  public async listConnections(
    organizationId: string,
    providerConnectionId?: string,
  ): Promise<BucketConnectionSummary[]> {
    const buckets = await this.database.bucketConnection.findMany({
      where: {
        organizationId,
        ...(providerConnectionId ? { providerConnectionId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return buckets.map((bucket) => this.toSummary(bucket));
  }

  public async get(
    organizationId: string,
    bucketConnectionId: string,
  ): Promise<BucketConnectionSummary> {
    const bucket = await this.database.bucketConnection.findFirst({
      where: { id: bucketConnectionId, organizationId },
    });
    if (!bucket) throw new BucketConnectionNotFound();
    return this.toSummary(bucket);
  }

  public async updateStatus(
    organizationId: string,
    bucketConnectionId: string,
    input: BucketConnectionStatusUpdateRequest,
    metadata: BucketActionMetadata,
  ): Promise<BucketConnectionSummary> {
    const bucket = await this.database.$transaction(async (transaction) => {
      const updated = await transaction.bucketConnection.updateMany({
        where: { id: bucketConnectionId, organizationId },
        data: { status: input.status },
      });
      if (updated.count !== 1) throw new BucketConnectionNotFound();

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "buckets.update",
          entityType: "BucketConnection",
          entityId: bucketConnectionId,
          requestId: metadata.requestId,
          metadata: { status: input.status },
        },
      });

      return transaction.bucketConnection.findFirstOrThrow({
        where: { id: bucketConnectionId, organizationId },
      });
    });

    return this.toSummary(bucket);
  }

  public async delete(
    organizationId: string,
    bucketConnectionId: string,
    metadata: BucketActionMetadata,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const bucket = await transaction.bucketConnection.findFirst({
        where: { id: bucketConnectionId, organizationId },
        select: { id: true, status: true },
      });
      if (!bucket) throw new BucketConnectionNotFound();
      if (bucket.status !== "DISABLED") {
        throw new BucketConnectionMustBeDisabled();
      }

      await transaction.bucketConnection.delete({
        where: { id: bucketConnectionId },
      });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "buckets.delete",
          entityType: "BucketConnection",
          entityId: bucketConnectionId,
          requestId: metadata.requestId,
          metadata: { deleted: true },
        },
      });
    });
  }

  public async import(
    organizationId: string,
    input: BucketImportRequest,
    metadata: BucketActionMetadata,
  ): Promise<BucketConnectionSummary> {
    const adapter = await this.providerService.adapterFor(
      organizationId,
      input.providerConnectionId,
    );

    try {
      await adapter.testConnection(input.bucketName);
    } catch {
      throw new BucketConnectionAccessError("BUCKET_ACCESS_FAILED");
    }

    const bucketId = randomUUID();
    const bucket = await this.database.$transaction(async (transaction) => {
      const created = await transaction.bucketConnection.create({
        data: {
          id: bucketId,
          organizationId,
          providerConnectionId: input.providerConnectionId,
          bucketName: input.bucketName,
          status: "ACTIVE",
        },
      });

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "buckets.import",
          entityType: "BucketConnection",
          entityId: bucketId,
          requestId: metadata.requestId,
          metadata: {
            bucketName: input.bucketName,
            providerConnectionId: input.providerConnectionId,
          },
        },
      });

      return created;
    });

    return this.toSummary(bucket);
  }

  private toSummary(bucket: {
    bucketName: string;
    createdAt: Date;
    id: string;
    providerConnectionId: string;
    status: string;
  }): BucketConnectionSummary {
    return {
      bucketName: bucket.bucketName,
      createdAt: bucket.createdAt.toISOString(),
      id: bucket.id,
      providerConnectionId: bucket.providerConnectionId,
      status: bucket.status,
    };
  }
}
