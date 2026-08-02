import { randomUUID } from "node:crypto";

import {
  LocalFileKeyEncryptionKeyProvider,
  ProviderCredentialCipher,
} from "@mosp/storage-core";
import {
  S3ProviderAdapter,
  assertSafeProviderEndpoint,
  createSafeProviderLookup,
  type ConnectionTestResult,
} from "@mosp/provider-s3";
import { Prisma, type PrismaClient } from "@mosp/db";
import type {
  ProviderConnectionCreateRequest,
  ProviderConnectionTestRequest,
  ProviderConnectionUpdateRequest,
} from "@mosp/shared";

export interface ProviderActionMetadata {
  actorId: string;
  requestId: string;
}

export interface ProviderConnectionServiceOptions {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  allowedPorts: readonly number[];
  credentialKeyFile: string;
}

export interface ProviderConnectionSummary {
  addressingMode: string;
  displayName: string;
  endpoint: string;
  id: string;
  lastHealthCheckedAt: string | null;
  region: string;
  status: string;
  type: string;
}

export interface ProviderTestResult {
  bucketNames: string[];
  capabilities: ConnectionTestResult["capabilities"];
  ok: boolean;
}

export class ProviderConnectionNotFound extends Error {}
export class ProviderConnectionInUse extends Error {}

export class ProviderConnectionValidationError extends Error {}

export class ProviderConnectionService {
  private readonly cipher: ProviderCredentialCipher;

  public constructor(
    private readonly database: PrismaClient,
    options: ProviderConnectionServiceOptions,
  ) {
    this.cipher = new ProviderCredentialCipher(
      new LocalFileKeyEncryptionKeyProvider(options.credentialKeyFile),
    );
    this.allowHttp = options.allowHttp;
    this.allowPrivateNetwork = options.allowPrivateNetwork;
    this.allowedPorts = options.allowedPorts;
  }

  private readonly allowHttp: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowedPorts: readonly number[];

  public async create(
    organizationId: string,
    input: ProviderConnectionCreateRequest,
    metadata: ProviderActionMetadata,
  ): Promise<ProviderConnectionSummary> {
    let endpoint: URL;
    try {
      endpoint = await assertSafeProviderEndpoint(input.endpoint, {
        allowHttp: this.allowHttp,
        allowPrivateNetwork: this.allowPrivateNetwork,
        allowedPorts: this.allowedPorts,
      });
    } catch {
      throw new ProviderConnectionValidationError("INVALID_PROVIDER_ENDPOINT");
    }

    const providerConnectionId = randomUUID();
    const encrypted = await this.cipher.encrypt(providerConnectionId, {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken,
    });

    const provider = await this.database.$transaction(async (transaction) => {
      const created = await transaction.providerConnection.create({
        data: {
          id: providerConnectionId,
          organizationId,
          displayName: input.displayName,
          type: input.type,
          endpoint: endpoint.toString(),
          region: input.region,
          addressingMode: input.addressingMode,
          status: "PENDING",
        },
      });

      await transaction.providerCredential.create({
        data: {
          providerConnectionId,
          encryptedPayload: Buffer.from(encrypted.encryptedPayload),
          encryptedDataKey: Buffer.from(encrypted.encryptedDataKey),
          iv: Buffer.from(encrypted.iv),
          authTag: Buffer.from(encrypted.authTag),
          algorithm: encrypted.algorithm,
          formatVersion: encrypted.formatVersion,
          keyVersion: encrypted.keyVersion,
        },
      });

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "providers.create",
          entityType: "ProviderConnection",
          entityId: providerConnectionId,
          requestId: metadata.requestId,
          metadata: { type: input.type, addressingMode: input.addressingMode },
        },
      });

      return created;
    });

    return this.toSummary(provider);
  }

  public async list(organizationId: string): Promise<ProviderConnectionSummary[]> {
    const providers = await this.database.providerConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });

    return providers.map((provider) => this.toSummary(provider));
  }

  public async get(
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConnectionSummary> {
    const provider = await this.database.providerConnection.findFirst({
      where: { id: providerId, organizationId },
    });
    if (!provider) throw new ProviderConnectionNotFound();
    return this.toSummary(provider);
  }

  public async update(
    organizationId: string,
    providerId: string,
    input: ProviderConnectionUpdateRequest,
    metadata: ProviderActionMetadata,
  ): Promise<ProviderConnectionSummary> {
    const current = await this.database.providerConnection.findFirst({
      where: { id: providerId, organizationId },
      include: { credential: true },
    });
    if (!current || !current.credential) throw new ProviderConnectionNotFound();

    let endpoint: URL | undefined;
    if (input.endpoint !== undefined) {
      try {
        endpoint = await assertSafeProviderEndpoint(input.endpoint, {
          allowHttp: this.allowHttp,
          allowPrivateNetwork: this.allowPrivateNetwork,
          allowedPorts: this.allowedPorts,
        });
      } catch {
        throw new ProviderConnectionValidationError("INVALID_PROVIDER_ENDPOINT");
      }
    }

    const credentialUpdate =
      input.accessKeyId !== undefined ||
      input.secretAccessKey !== undefined ||
      input.sessionToken !== undefined;
    if (
      credentialUpdate &&
      (input.accessKeyId === undefined || input.secretAccessKey === undefined)
    ) {
      throw new ProviderConnectionValidationError("INVALID_PROVIDER_CREDENTIALS");
    }

    const encrypted = credentialUpdate
      ? await this.cipher.encrypt(providerId, {
          accessKeyId: input.accessKeyId!,
          secretAccessKey: input.secretAccessKey!,
          ...(input.sessionToken
            ? { sessionToken: input.sessionToken }
            : {}),
        })
      : undefined;
    const connectionChanged =
      endpoint !== undefined ||
      input.region !== undefined ||
      input.addressingMode !== undefined ||
      credentialUpdate;

    const provider = await this.database.$transaction(async (transaction) => {
      const updated = await transaction.providerConnection.updateMany({
        where: { id: providerId, organizationId },
        data: {
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          ...(endpoint !== undefined ? { endpoint: endpoint.toString() } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.addressingMode !== undefined
            ? { addressingMode: input.addressingMode }
            : {}),
          ...(connectionChanged
            ? {
                status: "PENDING",
                lastHealthCheckedAt: null,
                healthDetails: Prisma.DbNull,
              }
            : {}),
        },
      });
      if (updated.count !== 1) throw new ProviderConnectionNotFound();

      if (encrypted) {
        await transaction.providerCredential.update({
          where: { providerConnectionId: providerId },
          data: {
            encryptedPayload: Buffer.from(encrypted.encryptedPayload),
            encryptedDataKey: Buffer.from(encrypted.encryptedDataKey),
            iv: Buffer.from(encrypted.iv),
            authTag: Buffer.from(encrypted.authTag),
            algorithm: encrypted.algorithm,
            formatVersion: encrypted.formatVersion,
            keyVersion: encrypted.keyVersion,
            rotatedAt: new Date(),
          },
        });
      }

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "providers.update",
          entityType: "ProviderConnection",
          entityId: providerId,
          requestId: metadata.requestId,
          metadata: {
            fieldsChanged: Object.keys(input).filter(
              (field) => !["accessKeyId", "secretAccessKey", "sessionToken"].includes(field),
            ),
            credentialsRotated: credentialUpdate,
          },
        },
      });

      return transaction.providerConnection.findFirstOrThrow({
        where: { id: providerId, organizationId },
      });
    });

    return this.toSummary(provider);
  }

  public async delete(
    organizationId: string,
    providerId: string,
    metadata: ProviderActionMetadata,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const provider = await transaction.providerConnection.findFirst({
        where: { id: providerId, organizationId },
        select: { id: true },
      });
      if (!provider) throw new ProviderConnectionNotFound();

      const bucketCount = await transaction.bucketConnection.count({
        where: { providerConnectionId: providerId, organizationId },
      });
      if (bucketCount > 0) throw new ProviderConnectionInUse();

      await transaction.providerConnection.delete({ where: { id: providerId } });
      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "providers.delete",
          entityType: "ProviderConnection",
          entityId: providerId,
          requestId: metadata.requestId,
          metadata: { deleted: true },
        },
      });
    });
  }

  public async test(
    organizationId: string,
    providerId: string,
    input: ProviderConnectionTestRequest,
    metadata: ProviderActionMetadata,
  ): Promise<ProviderTestResult> {
    const adapter = await this.adapterFor(organizationId, providerId);

    try {
      const result = await adapter.testConnection(input.bucketName);
      await this.recordTestResult(organizationId, providerId, metadata, result, true);
      return { ...result, ok: true };
    } catch (error) {
      await this.recordTestResult(
        organizationId,
        providerId,
        metadata,
        { bucketNames: [], capabilities: [] },
        false,
        this.sanitizeErrorCode(error),
      );
      return { bucketNames: [], capabilities: [], ok: false };
    }
  }

  public async adapterFor(
    organizationId: string,
    providerId: string,
    operationTimeoutMs?: number,
  ): Promise<S3ProviderAdapter> {
    const provider = await this.database.providerConnection.findFirst({
      where: { id: providerId, organizationId },
      include: { credential: true },
    });

    if (!provider || !provider.credential) {
      throw new ProviderConnectionNotFound();
    }

    const endpoint = await assertSafeProviderEndpoint(provider.endpoint, {
      allowHttp: this.allowHttp,
      allowPrivateNetwork: this.allowPrivateNetwork,
      allowedPorts: this.allowedPorts,
    });

    const credential = await this.cipher.decrypt(provider.id, {
      algorithm: provider.credential.algorithm as "aes-256-gcm",
      authTag: provider.credential.authTag,
      encryptedDataKey: provider.credential.encryptedDataKey,
      encryptedPayload: provider.credential.encryptedPayload,
      formatVersion: provider.credential.formatVersion as 1,
      iv: provider.credential.iv,
      keyVersion: provider.credential.keyVersion,
    });

    return new S3ProviderAdapter({
      addressingMode: provider.addressingMode,
      credentials: {
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {}),
      },
      endpoint: endpoint.toString(),
      endpointLookup: createSafeProviderLookup({
        allowPrivateNetwork: this.allowPrivateNetwork,
      }),
      region: provider.region,
      ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    });
  }

  private async recordTestResult(
    organizationId: string,
    providerId: string,
    metadata: ProviderActionMetadata,
    result: ConnectionTestResult,
    healthy: boolean,
    errorCode?: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.providerConnection.update({
        where: { id: providerId },
        data: {
          status: healthy ? "HEALTHY" : "UNHEALTHY",
          lastHealthCheckedAt: new Date(),
          healthDetails: healthy
            ? { bucketCount: result.bucketNames.length }
            : { code: errorCode ?? "PROVIDER_CONNECTION_FAILED" },
        },
      });

      for (const capability of result.capabilities) {
        await transaction.providerCapability.upsert({
          where: {
            providerConnectionId_capability: {
              providerConnectionId: providerId,
              capability: capability.capability,
            },
          },
          create: {
            providerConnectionId: providerId,
            capability: capability.capability,
            supported: capability.supported,
            ...(capability.details ? { details: capability.details } : {}),
          },
          update: {
            supported: capability.supported,
            ...(capability.details ? { details: capability.details } : {}),
            testedAt: new Date(),
          },
        });
      }

      await transaction.activityLog.create({
        data: {
          organizationId,
          actorId: metadata.actorId,
          action: "providers.test",
          entityType: "ProviderConnection",
          entityId: providerId,
          requestId: metadata.requestId,
          metadata: {
            bucketCount: result.bucketNames.length,
            capabilities: result.capabilities.map((capability) => ({
              capability: capability.capability,
              supported: capability.supported,
            })),
          },
        },
      });
    });
  }

  private sanitizeErrorCode(error: unknown): string {
    if (error && typeof error === "object" && "name" in error) {
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
        return name;
      }
    }

    return "PROVIDER_CONNECTION_FAILED";
  }

  private toSummary(provider: {
    id: string;
    displayName: string;
    endpoint: string;
    region: string;
    addressingMode: string;
    type: string;
    status: string;
    lastHealthCheckedAt: Date | null;
  }): ProviderConnectionSummary {
    return {
      addressingMode: provider.addressingMode,
      displayName: provider.displayName,
      endpoint: provider.endpoint,
      id: provider.id,
      lastHealthCheckedAt: provider.lastHealthCheckedAt?.toISOString() ?? null,
      region: provider.region,
      status: provider.status,
      type: provider.type,
    };
  }
}
