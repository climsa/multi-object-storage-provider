import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { Prisma, type PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";
import type { UploadCompleteRequest, UploadInitiateRequest } from "@mosp/shared";

import type { ApiCredentialIdentity } from "../auth/api-credential.js";
import { FolderGrantService } from "../folder-grants/service.js";
import { ProviderConnectionService } from "../providers/service.js";
import { StorageNamespaceNotFound } from "./object-service.js";
import { PlacementService } from "./placement-service.js";
import {
  DEFAULT_PROXY_TRANSFER_CONFIG,
  type ProxyTransferConfig,
} from "./transfer.js";

const PRESIGNED_URL_TTL_SECONDS = 900;
const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;
const MULTIPART_THRESHOLD_BYTES = 64n * 1024n * 1024n;
const MULTIPART_PART_SIZE_BYTES = 64n * 1024n * 1024n;
const MAX_MULTIPART_PARTS = 10_000;
const MAX_ACTIVE_UPLOADS_PER_CREDENTIAL = 100;
const MAX_ACTIVE_UPLOADS_PER_NAMESPACE = 1_000;

export interface UploadSessionSummary {
  expiresAt: string;
  headers?: Record<string, string>;
  key: string;
  partCount?: number;
  partSizeBytes?: string;
  sizeBytes: string;
  state: string;
  transferMode: "DIRECT" | "MULTIPART" | "PROXIED";
  uploadId: string;
  url?: string;
}

export class UploadQuotaExceeded extends Error {}
export class UploadConcurrencyExceeded extends Error {}
export class UploadTargetUnavailable extends Error {}
export class UploadIdempotencyConflict extends Error {}
export class UploadSessionNotFound extends Error {}
export class UploadSessionConflict extends Error {}
export class UploadVerificationFailed extends Error {}
export class UploadObjectAlreadyExists extends Error {}
export class UploadProviderError extends Error {}
export class UploadProxyLengthRequired extends Error {}
export class UploadProxySizeMismatch extends Error {}
export class UploadProxyObjectTooLarge extends Error {}

type UploadTransaction = Prisma.TransactionClient;

export class UploadService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly folderGrantService: FolderGrantService,
    private readonly providerService: ProviderConnectionService,
    private readonly placementService: PlacementService,
    private readonly proxyTransferConfig: ProxyTransferConfig = DEFAULT_PROXY_TRANSFER_CONFIG,
  ) {}

  public async initiate(
    identity: ApiCredentialIdentity,
    namespaceSlug: string,
    input: UploadInitiateRequest,
  ): Promise<UploadSessionSummary> {
    const namespace = await this.database.virtualNamespace.findFirst({
      where: { organizationId: identity.organizationId, slug: namespaceSlug },
      select: {
        id: true,
        status: true,
        quotaBytes: true,
        maxObjectSizeBytes: true,
        defaultTransferMode: true,
      },
    });
    if (!namespace || namespace.id !== identity.namespaceId || namespace.status !== "ACTIVE") {
      throw new StorageNamespaceNotFound();
    }
    if (
      !(await this.folderGrantService.canAccess({
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        principalType: identity.principalType,
        principalId: identity.principalId,
        action: "write",
        key: input.key,
      }))
    ) {
      throw new UploadSessionNotFound();
    }

    const sizeBytes = BigInt(input.sizeBytes);
    if (namespace.maxObjectSizeBytes !== null && sizeBytes > namespace.maxObjectSizeBytes) {
      throw new UploadQuotaExceeded();
    }

    const existing = await this.database.uploadSession.findFirst({
      where: {
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        idempotencyKey: input.idempotencyKey,
        createdByCredentialId: identity.credentialId,
      },
      include: { bucketConnection: { select: { bucketName: true, providerConnectionId: true } } },
    });
    if (existing) {
      if (
        existing.logicalKey !== input.key ||
        existing.reservedBytes !== sizeBytes ||
        existing.contentType !== (input.contentType ?? null) ||
        existing.checksum !== (input.checksum ?? null) ||
        existing.allowOverwrite !== input.overwrite
      ) {
        throw new UploadIdempotencyConflict();
      }
      if (existing.state !== "INITIATED" || existing.expiresAt <= new Date()) {
        return this.toSummary(existing);
      }
      return this.presign(existing, existing.bucketConnection.bucketName, existing.bucketConnection.providerConnectionId);
    }

    const existingObject = await this.database.objectRecord.findFirst({
      where: {
        organizationId: identity.organizationId,
        namespaceId: namespace.id,
        logicalKey: input.key,
        state: "AVAILABLE",
      },
      select: { id: true },
    });
    if (existingObject && !input.overwrite) throw new UploadObjectAlreadyExists();

    const target = await this.placementService.selectTarget(
      identity.organizationId,
      namespace.id,
      sizeBytes,
    );
    if (!target) throw new UploadTargetUnavailable();

    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
    const physicalKey = `objects/${namespace.id}/${randomUUID()}`;
    const transferMode = namespace.defaultTransferMode === "PROXIED"
      ? "PROXIED"
      : sizeBytes >= MULTIPART_THRESHOLD_BYTES
        ? "MULTIPART"
        : "DIRECT";
    let providerUploadId: string | undefined;
    if (transferMode === "MULTIPART") {
      try {
        const adapter = await this.providerService.adapterFor(
          identity.organizationId,
          target.bucketConnection.providerConnectionId,
        );
        providerUploadId = (
          await adapter.createMultipartUpload(
            target.bucketConnection.bucketName,
            physicalKey,
            input.contentType,
          )
        ).uploadId;
      } catch (error) {
        throw new UploadProviderError(error instanceof Error ? error.message : "MULTIPART_CREATE_FAILED");
      }
    }

    let session;
    try {
      session = await this.database.$transaction(async (transaction) => {
        await this.lockUsageCounter(transaction, identity.organizationId, namespace.id);
        const counter = await transaction.usageCounter.findUniqueOrThrow({
          where: { organizationId_namespaceId: { organizationId: identity.organizationId, namespaceId: namespace.id } },
        });
        if (!(await this.placementService.assertTargetCapacity(
          transaction,
          identity.organizationId,
          namespace.id,
          target.id,
          sizeBytes,
        ))) {
          throw new UploadTargetUnavailable();
        }
        if (
          counter.activeUploadCount >= MAX_ACTIVE_UPLOADS_PER_NAMESPACE ||
          (await transaction.uploadSession.count({
            where: {
              organizationId: identity.organizationId,
              namespaceId: namespace.id,
              createdByCredentialId: identity.credentialId,
              state: "INITIATED",
            },
          })) >= MAX_ACTIVE_UPLOADS_PER_CREDENTIAL
        ) {
          throw new UploadConcurrencyExceeded();
        }
        if (counter.usedBytes + counter.reservedBytes + sizeBytes > namespace.quotaBytes) {
          throw new UploadQuotaExceeded();
        }
        await transaction.usageCounter.update({
          where: { organizationId_namespaceId: { organizationId: identity.organizationId, namespaceId: namespace.id } },
          data: { reservedBytes: { increment: sizeBytes }, activeUploadCount: { increment: 1 } },
        });
        return transaction.uploadSession.create({
          data: {
            id: uploadId,
            organizationId: identity.organizationId,
            namespaceId: namespace.id,
            placementTargetId: target.id,
            bucketConnectionId: target.bucketConnection.id,
            createdByCredentialId: identity.credentialId,
            idempotencyKey: input.idempotencyKey,
            logicalKey: input.key,
            physicalKey,
            reservedBytes: sizeBytes,
            allowOverwrite: input.overwrite,
            contentType: input.contentType ?? null,
            checksum: input.checksum ?? null,
            transferMode,
            providerUploadId: providerUploadId ?? null,
            expiresAt,
          },
        });
      });
    } catch (error) {
      if (providerUploadId) {
        await this.providerService
          .adapterFor(identity.organizationId, target.bucketConnection.providerConnectionId)
          .then((adapter) => adapter.abortMultipartUpload(target.bucketConnection.bucketName, physicalKey, providerUploadId!))
          .catch(() => undefined);
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2002"
      ) {
        throw new UploadIdempotencyConflict();
      }
      throw error;
    }

    try {
      return await this.presign(
        session,
        target.bucketConnection.bucketName,
        target.bucketConnection.providerConnectionId,
      );
    } catch (error) {
      if (session.transferMode === "MULTIPART" && session.providerUploadId && !session.providerUploadFinalized) {
        await this.providerService
          .adapterFor(identity.organizationId, target.bucketConnection.providerConnectionId)
          .then((adapter) => adapter.abortMultipartUpload(target.bucketConnection.bucketName, physicalKey, session.providerUploadId!))
          .catch(() => undefined);
      }
      await this.releaseReservation(identity.organizationId, namespace.id, uploadId).catch(() => undefined);
      throw new UploadProviderError(error instanceof Error ? error.message : "PRESIGN_FAILED");
    }
  }

  public async proxyUpload(
    identity: ApiCredentialIdentity,
    uploadId: string,
    body: Readable,
    contentLengthBytes: bigint,
    abortSignal?: AbortSignal,
  ): Promise<UploadSessionSummary> {
    if (contentLengthBytes < 0n) throw new UploadProxyObjectTooLarge();
    const session = await this.database.uploadSession.findFirst({
      where: {
        id: uploadId,
        organizationId: identity.organizationId,
        namespaceId: identity.namespaceId,
        createdByCredentialId: identity.credentialId,
      },
      include: {
        bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
      },
    });
    if (!session) throw new UploadSessionNotFound();
    if (session.transferMode !== "PROXIED" || session.state !== "INITIATED") {
      throw new UploadSessionConflict();
    }
    if (session.expiresAt <= new Date()) {
      await this.expire(session.organizationId, session.namespaceId, session.id);
      throw new UploadSessionConflict();
    }
    if (
      contentLengthBytes > this.proxyTransferConfig.maxObjectBytes ||
      contentLengthBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      await this.releaseReservation(session.organizationId, session.namespaceId, session.id);
      throw new UploadProxyObjectTooLarge();
    }
    if (contentLengthBytes !== session.reservedBytes) {
      await this.releaseReservation(session.organizationId, session.namespaceId, session.id);
      throw new UploadProxySizeMismatch();
    }

    let adapter: S3ProviderAdapter | undefined;
    try {
      adapter = await this.providerService.adapterFor(
        identity.organizationId,
        session.bucketConnection.providerConnectionId,
        this.proxyTransferConfig.timeoutMs,
      );
      await adapter.putObject(
        session.bucketConnection.bucketName,
        session.physicalKey,
        body,
        session.contentType,
        Number(contentLengthBytes),
        abortSignal,
      );
      return await this.complete(identity, uploadId, {});
    } catch (error) {
      body.destroy();
      await this.cleanupFailedUpload(adapter, session, false).catch(() => undefined);
      if (
        error instanceof UploadSessionConflict ||
        error instanceof UploadObjectAlreadyExists ||
        error instanceof UploadVerificationFailed ||
        error instanceof UploadProviderError
      ) {
        throw error;
      }
      throw new UploadProviderError(error instanceof Error ? error.message : "PROXY_UPLOAD_FAILED");
    }
  }

  public async presignPart(
    identity: ApiCredentialIdentity,
    uploadId: string,
    partNumber: number,
  ): Promise<{ expiresAt: string; method: "PUT"; url: string }> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_MULTIPART_PARTS) {
      throw new UploadSessionConflict();
    }
    const session = await this.database.uploadSession.findFirst({
      where: {
        id: uploadId,
        organizationId: identity.organizationId,
        namespaceId: identity.namespaceId,
        createdByCredentialId: identity.credentialId,
      },
      include: {
        bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
      },
    });
    if (!session) throw new UploadSessionNotFound();
    if (session.transferMode !== "MULTIPART" || !session.providerUploadId || session.state !== "INITIATED") {
      throw new UploadSessionConflict();
    }
    if (session.expiresAt <= new Date()) {
      await this.expire(session.organizationId, session.namespaceId, session.id);
      throw new UploadSessionConflict();
    }
    const partCount = this.multipartPartCount(session.reservedBytes);
    if (partNumber > partCount) throw new UploadSessionConflict();
    try {
      const adapter = await this.providerService.adapterFor(
        identity.organizationId,
        session.bucketConnection.providerConnectionId,
      );
      const transfer = await adapter.createPresignedUploadPart(
        session.bucketConnection.bucketName,
        session.physicalKey,
        session.providerUploadId,
        partNumber,
        PRESIGNED_URL_TTL_SECONDS,
      );
      await this.database.multipartPart.upsert({
        where: { uploadSessionId_partNumber: { uploadSessionId: session.id, partNumber } },
        create: { organizationId: session.organizationId, uploadSessionId: session.id, partNumber },
        update: {},
      });
      return { method: "PUT", url: transfer.url, expiresAt: transfer.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof UploadSessionConflict) throw error;
      throw new UploadProviderError(error instanceof Error ? error.message : "MULTIPART_PRESIGN_FAILED");
    }
  }

  public async complete(
    identity: ApiCredentialIdentity,
    uploadId: string,
    input: UploadCompleteRequest = {},
  ): Promise<UploadSessionSummary> {
    const session = await this.database.uploadSession.findFirst({
      where: { id: uploadId, organizationId: identity.organizationId, namespaceId: identity.namespaceId, createdByCredentialId: identity.credentialId },
      include: {
        bucketConnection: { select: { bucketName: true, providerConnectionId: true } },
      },
    });
    if (!session) throw new UploadSessionNotFound();
    if (session.state === "COMPLETED") return this.toSummary(session);
    if (session.state !== "INITIATED") throw new UploadSessionConflict();
    if (session.expiresAt <= new Date()) {
      await this.expire(session.organizationId, session.namespaceId, session.id);
      throw new UploadSessionConflict();
    }

    if ((session.transferMode === "DIRECT" || session.transferMode === "PROXIED") && input.parts !== undefined) {
      throw new UploadSessionConflict();
    }
    let providerUploadFinalized = session.providerUploadFinalized;
    const multipartParts = session.transferMode === "MULTIPART" && !providerUploadFinalized
      ? this.validateMultipartParts(session.reservedBytes, input.parts)
      : undefined;

    let metadata: Awaited<ReturnType<S3ProviderAdapter["headObject"]>>;
    let adapter: S3ProviderAdapter | undefined;
    try {
      adapter = await this.providerService.adapterFor(identity.organizationId, session.bucketConnection.providerConnectionId);
      if (session.transferMode === "MULTIPART" && session.providerUploadId && multipartParts) {
        const alreadyFinalized = await adapter.objectExists(
          session.bucketConnection.bucketName,
          session.physicalKey,
        );
        if (!alreadyFinalized) {
          await adapter.completeMultipartUpload(
            session.bucketConnection.bucketName,
            session.physicalKey,
            session.providerUploadId,
            multipartParts.map((part) => ({ etag: part.etag, partNumber: part.partNumber })),
          );
        }
        const marked = await this.database.uploadSession.updateMany({
          where: { id: session.id, organizationId: identity.organizationId, state: "INITIATED" },
          data: { providerUploadFinalized: true },
        });
        if (marked.count !== 1) throw new UploadSessionConflict();
        providerUploadFinalized = true;
      }
      metadata = await adapter.headObject(session.bucketConnection.bucketName, session.physicalKey);
    } catch (error) {
      if (error instanceof UploadSessionConflict) throw error;
      throw new UploadProviderError(error instanceof Error ? error.message : "HEAD_FAILED");
    }
    if (
      metadata.sizeBytes !== session.reservedBytes ||
      (session.checksum?.startsWith("sha256:") && metadata.checksumSha256 !== session.checksum.slice(7))
    ) {
      await this.cleanupFailedUpload(adapter, session, providerUploadFinalized).catch(() => undefined);
      throw new UploadVerificationFailed();
    }

    const objectRecordId = randomUUID();
    const locationId = randomUUID();
    let replacedLocation: {
      bucketName: string;
      providerConnectionId: string;
      physicalKey: string;
    } | null = null;
    try {
      await this.database.$transaction(async (transaction) => {
        const claimed = await transaction.uploadSession.updateMany({
          where: { id: session.id, organizationId: identity.organizationId, state: "INITIATED" },
          data: { state: "COMPLETING" },
        });
        if (claimed.count !== 1) throw new UploadSessionConflict();
        let existing = await transaction.objectRecord.findFirst({
          where: { organizationId: identity.organizationId, namespaceId: session.namespaceId, logicalKey: session.logicalKey },
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
        if (existing) {
          await transaction.$queryRaw(
            Prisma.sql`SELECT "id" FROM "ObjectRecord" WHERE "id" = ${existing.id} AND "organizationId" = ${identity.organizationId} FOR UPDATE`,
          );
          existing = await transaction.objectRecord.findFirst({
            where: { id: existing.id, organizationId: identity.organizationId },
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
          if (!existing) throw new UploadSessionConflict();
        }
        if (existing && existing.state === "AVAILABLE" && !session.allowOverwrite) throw new UploadObjectAlreadyExists();
        if (existing && existing.state !== "AVAILABLE" && existing.state !== "DELETED") throw new UploadSessionConflict();
        if (existing) {
          if (existing.state === "DELETED") {
            await transaction.objectRecord.update({
              where: { id: existing.id },
              data: {
                state: "PENDING",
                activeObjectLocationId: locationId,
                sizeBytes: metadata.sizeBytes,
                contentType: session.contentType ?? metadata.contentType ?? null,
                checksum: session.checksum ?? null,
              },
            });
          } else {
          const activeLocation = existing.activeObjectLocation;
          if (!activeLocation) throw new UploadSessionConflict();
          await transaction.objectLocation.updateMany({
            where: {
              id: activeLocation.id,
              organizationId: identity.organizationId,
              state: "ACTIVE",
            },
            data: { state: "RETAINED" },
          });
          replacedLocation = {
            bucketName: activeLocation.bucketConnection.bucketName,
            providerConnectionId: activeLocation.bucketConnection.providerConnectionId,
            physicalKey: activeLocation.physicalKey,
          };
          await transaction.objectRecord.update({
            where: { id: existing.id },
            data: {
              state: "AVAILABLE",
              activeObjectLocationId: locationId,
              sizeBytes: metadata.sizeBytes,
              contentType: session.contentType ?? metadata.contentType ?? null,
              checksum: session.checksum ?? null,
            },
          });
          }
        } else {
          await transaction.objectRecord.create({
            data: {
              id: objectRecordId,
              organizationId: identity.organizationId,
              namespaceId: session.namespaceId,
              logicalKey: session.logicalKey,
              state: "PENDING",
              sizeBytes: metadata.sizeBytes,
              contentType: session.contentType ?? metadata.contentType ?? null,
              checksum: session.checksum ?? null,
            },
          });
        }
        await transaction.objectLocation.create({
          data: {
            id: locationId,
            organizationId: identity.organizationId,
            objectRecordId: existing?.id ?? objectRecordId,
            bucketConnectionId: session.bucketConnectionId,
            physicalKey: session.physicalKey,
            state: "ACTIVE",
            etag: metadata.etag ?? null,
            verifiedAt: new Date(),
            providerLastModified: metadata.lastModified ?? null,
          },
        });
        if (!existing || existing.state === "DELETED") {
          await transaction.objectRecord.update({
            where: { id: existing?.id ?? objectRecordId },
            data: { state: "AVAILABLE", activeObjectLocationId: locationId },
          });
        }
        if (multipartParts) {
          for (const part of multipartParts) {
            await transaction.multipartPart.upsert({
              where: { uploadSessionId_partNumber: { uploadSessionId: session.id, partNumber: part.partNumber } },
              create: {
                organizationId: identity.organizationId,
                uploadSessionId: session.id,
                partNumber: part.partNumber,
                etag: part.etag,
                sizeBytes: BigInt(part.sizeBytes),
              },
              update: { etag: part.etag, sizeBytes: BigInt(part.sizeBytes) },
            });
          }
        }
        await this.lockUsageCounter(transaction, identity.organizationId, session.namespaceId);
        const usageDelta = existing && existing.state === "AVAILABLE"
          ? metadata.sizeBytes - existing.sizeBytes
          : metadata.sizeBytes;
        await transaction.usageCounter.update({
          where: { organizationId_namespaceId: { organizationId: identity.organizationId, namespaceId: session.namespaceId } },
          data: {
            reservedBytes: { decrement: session.reservedBytes },
            ...(usageDelta >= 0n
              ? { usedBytes: { increment: usageDelta } }
              : { usedBytes: { decrement: -usageDelta } }),
            ...(!existing || existing.state === "DELETED" ? { objectCount: { increment: 1n } } : {}),
            activeUploadCount: { decrement: 1 },
            ingressBytes: { increment: metadata.sizeBytes },
          },
        });
        await transaction.uploadSession.update({
          where: { id: session.id },
          data: { state: "COMPLETED", completedAt: new Date() },
        });
      });
      if (replacedLocation) {
        await this.deleteRetainedLocation(identity.organizationId, replacedLocation).catch(() => undefined);
      }
    } catch (error) {
      if (providerUploadFinalized) {
        await this.cleanupFinalizedProviderObject(identity, session).catch(() => undefined);
      }
      if (error instanceof UploadSessionConflict || error instanceof UploadObjectAlreadyExists) throw error;
      throw error;
    }
    return { ...this.toSummary(session), state: "COMPLETED" };
  }

  public async abort(identity: ApiCredentialIdentity, uploadId: string): Promise<void> {
    const session = await this.database.uploadSession.findFirst({
      where: { id: uploadId, organizationId: identity.organizationId, namespaceId: identity.namespaceId, createdByCredentialId: identity.credentialId },
      include: { bucketConnection: { select: { bucketName: true, providerConnectionId: true } } },
    });
    if (!session) throw new UploadSessionNotFound();
    if (session.state === "ABORTED" || session.state === "EXPIRED") return;
    if (session.state !== "INITIATED") throw new UploadSessionConflict();
    try {
      const adapter = await this.providerService.adapterFor(identity.organizationId, session.bucketConnection.providerConnectionId);
      if (session.transferMode === "MULTIPART" && session.providerUploadId && !session.providerUploadFinalized) {
        await adapter.abortMultipartUpload(
          session.bucketConnection.bucketName,
          session.physicalKey,
          session.providerUploadId,
        );
      } else {
        await adapter.deleteObject(session.bucketConnection.bucketName, session.physicalKey);
      }
    } catch (error) {
      throw new UploadProviderError(error instanceof Error ? error.message : "DELETE_FAILED");
    }
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.uploadSession.updateMany({
        where: { id: session.id, organizationId: identity.organizationId, state: "INITIATED" },
        data: { state: "ABORTED" },
      });
      if (changed.count !== 1) throw new UploadSessionConflict();
      await this.lockUsageCounter(transaction, identity.organizationId, session.namespaceId);
      await transaction.usageCounter.update({
        where: { organizationId_namespaceId: { organizationId: identity.organizationId, namespaceId: session.namespaceId } },
        data: { reservedBytes: { decrement: session.reservedBytes }, activeUploadCount: { decrement: 1 } },
      });
    });
  }

  private async presign(
    session: {
      id: string;
      logicalKey: string;
      reservedBytes: bigint;
      state: string;
      expiresAt: Date;
      physicalKey: string;
      contentType?: string | null;
      transferMode?: string;
    },
    bucketName: string,
    providerConnectionId: string,
  ): Promise<UploadSessionSummary> {
    if (session.transferMode === "MULTIPART" || session.transferMode === "PROXIED") {
      return this.toSummary(session);
    }
    const adapter = await this.providerService.adapterFor(
      (await this.database.uploadSession.findUniqueOrThrow({ where: { id: session.id }, select: { organizationId: true } })).organizationId,
      providerConnectionId,
    );
    const transfer = await adapter.createPresignedUpload(bucketName, session.physicalKey, session.contentType ?? undefined, PRESIGNED_URL_TTL_SECONDS);
    return {
      ...this.toSummary(session),
      url: transfer.url,
      expiresAt: transfer.expiresAt.toISOString(),
      ...(transfer.headers ? { headers: transfer.headers } : {}),
    };
  }

  private toSummary(session: {
    id: string;
    logicalKey: string;
    reservedBytes: bigint;
    state: string;
    expiresAt: Date;
    transferMode?: string;
  }): UploadSessionSummary {
    const transferMode = session.transferMode === "MULTIPART"
      ? "MULTIPART"
      : session.transferMode === "PROXIED"
        ? "PROXIED"
        : "DIRECT";
    return {
      uploadId: session.id,
      key: session.logicalKey,
      sizeBytes: session.reservedBytes.toString(),
      state: session.state,
      transferMode,
      expiresAt: session.expiresAt.toISOString(),
      ...(transferMode === "MULTIPART"
        ? {
            partSizeBytes: MULTIPART_PART_SIZE_BYTES.toString(),
            partCount: this.multipartPartCount(session.reservedBytes),
          }
        : {}),
    };
  }

  private multipartPartCount(sizeBytes: bigint): number {
    const count = Number((sizeBytes + MULTIPART_PART_SIZE_BYTES - 1n) / MULTIPART_PART_SIZE_BYTES);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_MULTIPART_PARTS) {
      throw new UploadQuotaExceeded();
    }
    return count;
  }

  private validateMultipartParts(
    sizeBytes: bigint,
    parts: UploadCompleteRequest["parts"],
  ): NonNullable<UploadCompleteRequest["parts"]> {
    const expectedCount = this.multipartPartCount(sizeBytes);
    if (!parts || parts.length !== expectedCount) throw new UploadVerificationFailed();
    const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    let total = 0n;
    for (const [index, part] of sorted.entries()) {
      if (part.partNumber !== index + 1) throw new UploadVerificationFailed();
      total += BigInt(part.sizeBytes);
    }
    if (total !== sizeBytes) throw new UploadVerificationFailed();
    return sorted;
  }

  private async cleanupFinalizedProviderObject(
    identity: ApiCredentialIdentity,
    session: {
      id: string;
      organizationId: string;
      namespaceId: string;
      physicalKey: string;
      bucketConnection: { bucketName: string; providerConnectionId: string };
    },
  ): Promise<void> {
    const adapter = await this.providerService.adapterFor(
      identity.organizationId,
      session.bucketConnection.providerConnectionId,
    );
    await adapter.deleteObject(session.bucketConnection.bucketName, session.physicalKey);
    await this.releaseReservation(session.organizationId, session.namespaceId, session.id);
  }

  private async cleanupFailedUpload(
    adapter: S3ProviderAdapter | undefined,
    session: {
      id: string;
      organizationId: string;
      namespaceId: string;
      physicalKey: string;
      transferMode: string;
      providerUploadId: string | null;
      bucketConnection: { bucketName: string; providerConnectionId: string };
    },
    providerUploadFinalized: boolean,
  ): Promise<void> {
    try {
      if (!adapter) return;
      if (session.transferMode === "MULTIPART" && session.providerUploadId && !providerUploadFinalized) {
        await adapter.abortMultipartUpload(
          session.bucketConnection.bucketName,
          session.physicalKey,
          session.providerUploadId,
        );
      } else {
        await adapter.deleteObject(session.bucketConnection.bucketName, session.physicalKey);
      }
    } finally {
      await this.releaseReservation(session.organizationId, session.namespaceId, session.id);
    }
  }

  private async deleteRetainedLocation(
    organizationId: string,
    location: { bucketName: string; providerConnectionId: string; physicalKey: string },
  ): Promise<void> {
    const adapter = await this.providerService.adapterFor(
      organizationId,
      location.providerConnectionId,
    );
    await adapter.deleteObject(location.bucketName, location.physicalKey);
  }

  private async lockUsageCounter(transaction: UploadTransaction, organizationId: string, namespaceId: string): Promise<void> {
    await transaction.usageCounter.upsert({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      create: { id: randomUUID(), organizationId, namespaceId },
      update: {},
    });
    await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "UsageCounter" WHERE "organizationId" = ${organizationId} AND "namespaceId" = ${namespaceId} FOR UPDATE`);
  }

  private async releaseReservation(organizationId: string, namespaceId: string, uploadId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const session = await transaction.uploadSession.findFirst({ where: { id: uploadId, organizationId, namespaceId, state: "INITIATED" }, select: { reservedBytes: true } });
      if (!session) return;
      await transaction.uploadSession.update({ where: { id: uploadId }, data: { state: "ABORTED" } });
      await this.lockUsageCounter(transaction, organizationId, namespaceId);
      await transaction.usageCounter.update({ where: { organizationId_namespaceId: { organizationId, namespaceId } }, data: { reservedBytes: { decrement: session.reservedBytes }, activeUploadCount: { decrement: 1 } } });
    });
  }

  private async expire(organizationId: string, namespaceId: string, uploadId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const session = await transaction.uploadSession.findFirst({ where: { id: uploadId, organizationId, namespaceId, state: "INITIATED" }, select: { reservedBytes: true } });
      if (!session) return;
      await transaction.uploadSession.update({ where: { id: uploadId }, data: { state: "EXPIRED" } });
      await this.lockUsageCounter(transaction, organizationId, namespaceId);
      await transaction.usageCounter.update({ where: { organizationId_namespaceId: { organizationId, namespaceId } }, data: { reservedBytes: { decrement: session.reservedBytes }, activeUploadCount: { decrement: 1 } } });
    });
  }
}
