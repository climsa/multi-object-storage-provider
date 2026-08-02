import { createHash, randomBytes } from "node:crypto";

import type { Prisma, PrismaClient } from "@mosp/db";
import type {
  ApiCredentialCreateRequest,
  ApiCredentialRotateRequest,
} from "@mosp/shared";

export interface ApiCredentialActionMetadata {
  actorId: string;
  requestId: string;
}

export interface ApiCredentialSummary {
  createdAt: string;
  createdById: string;
  expiresAt: string | null;
  id: string;
  keyId: string;
  lastUsedAt: string | null;
  namespace: { id: string; name: string; slug: string };
  revokedAt: string | null;
  status: string;
  updatedAt: string;
}

export interface CreatedApiCredential {
  credential: ApiCredentialSummary;
  secret: string;
}

export class ApiCredentialNotFound extends Error {}
export class ApiCredentialNotActive extends Error {}
export class ApiCredentialNamespaceNotFound extends Error {}
export class ApiCredentialNamespaceDisabled extends Error {}
export class ApiCredentialExpiryInvalid extends Error {}

const credentialInclude = {
  namespace: { select: { id: true, name: true, slug: true } },
};

export class ApiCredentialService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(organizationId: string): Promise<ApiCredentialSummary[]> {
    const credentials = await this.database.apiCredential.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: credentialInclude,
    });
    return credentials.map((credential) => this.toSummary(credential));
  }

  public async create(
    organizationId: string,
    input: ApiCredentialCreateRequest,
    metadata: ApiCredentialActionMetadata,
  ): Promise<CreatedApiCredential> {
    const now = new Date();
    const expiresAt = this.parseExpiry(input.expiresAt, now);
    const generated = this.generateCredential();

    const credential = await this.database.$transaction(async (transaction) => {
      const namespace = await transaction.virtualNamespace.findFirst({
        where: { id: input.namespaceId, organizationId },
        select: { id: true, status: true },
      });
      if (!namespace) throw new ApiCredentialNamespaceNotFound();
      if (namespace.status !== "ACTIVE") throw new ApiCredentialNamespaceDisabled();

      const created = await transaction.apiCredential.create({
        data: {
          organizationId,
          namespaceId: input.namespaceId,
          keyId: generated.keyId,
          secretHash: generated.secretHash,
          status: "ACTIVE",
          expiresAt,
          createdById: metadata.actorId,
        },
        include: credentialInclude,
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "api_credentials.create",
        entityId: created.id,
        metadata: { keyId: created.keyId, namespaceId: created.namespaceId },
      });
      return created;
    });

    return { credential: this.toSummary(credential), secret: generated.secret };
  }

  public async rotate(
    organizationId: string,
    credentialId: string,
    input: ApiCredentialRotateRequest,
    metadata: ApiCredentialActionMetadata,
  ): Promise<CreatedApiCredential> {
    const now = new Date();
    const expiresAt = this.parseExpiry(input.expiresAt, now);
    const generated = this.generateCredential();

    const credential = await this.database.$transaction(async (transaction) => {
      const current = await transaction.apiCredential.findFirst({
        where: { id: credentialId, organizationId },
        select: { id: true, status: true, expiresAt: true },
      });
      if (!current) throw new ApiCredentialNotFound();
      if (
        current.status !== "ACTIVE" ||
        (current.expiresAt !== null && current.expiresAt <= now)
      ) {
        throw new ApiCredentialNotActive();
      }

      const updated = await transaction.apiCredential.update({
        where: { id: credentialId },
        data: {
          keyId: generated.keyId,
          secretHash: generated.secretHash,
          expiresAt,
          status: "ACTIVE",
          revokedAt: null,
        },
        include: credentialInclude,
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "api_credentials.rotate",
        entityId: credentialId,
        metadata: { keyId: updated.keyId, previousKeyRotated: true },
      });
      return updated;
    });

    return { credential: this.toSummary(credential), secret: generated.secret };
  }

  public async revoke(
    organizationId: string,
    credentialId: string,
    metadata: ApiCredentialActionMetadata,
  ): Promise<ApiCredentialSummary> {
    const credential = await this.database.$transaction(async (transaction) => {
      const current = await transaction.apiCredential.findFirst({
        where: { id: credentialId, organizationId },
        select: { id: true, status: true, keyId: true },
      });
      if (!current) throw new ApiCredentialNotFound();
      if (current.status !== "ACTIVE") throw new ApiCredentialNotActive();

      const updated = await transaction.apiCredential.update({
        where: { id: credentialId },
        data: { status: "REVOKED", revokedAt: new Date() },
        include: credentialInclude,
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "api_credentials.revoke",
        entityId: credentialId,
        metadata: { keyId: current.keyId },
      });
      return updated;
    });

    return this.toSummary(credential);
  }

  private parseExpiry(
    value: string | null | undefined,
    now: Date,
  ): Date | null {
    if (value === undefined || value === null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed <= now) {
      throw new ApiCredentialExpiryInvalid();
    }
    return parsed;
  }

  private generateCredential(): {
    keyId: string;
    secret: string;
    secretHash: string;
  } {
    const keyId = `mosp_${randomBytes(18).toString("base64url")}`;
    const secret = `mosp_secret_${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(secret, "utf8").digest("hex");
    return { keyId, secret, secretHash };
  }

  private async writeActivity(
    transaction: Pick<PrismaClient, "activityLog">,
    organizationId: string,
    metadata: ApiCredentialActionMetadata,
    input: { action: string; entityId: string; metadata: Prisma.InputJsonValue },
  ): Promise<void> {
    await transaction.activityLog.create({
      data: {
        organizationId,
        actorId: metadata.actorId,
        action: input.action,
        entityType: "ApiCredential",
        entityId: input.entityId,
        requestId: metadata.requestId,
        metadata: input.metadata,
      },
    });
  }

  private toSummary(credential: {
    id: string;
    keyId: string;
    status: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    namespace: { id: string; name: string; slug: string };
  }): ApiCredentialSummary {
    const effectiveStatus =
      credential.status === "ACTIVE" &&
      credential.expiresAt !== null &&
      credential.expiresAt <= new Date()
        ? "EXPIRED"
        : credential.status;
    return {
      id: credential.id,
      keyId: credential.keyId,
      status: effectiveStatus,
      expiresAt: credential.expiresAt?.toISOString() ?? null,
      lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
      revokedAt: credential.revokedAt?.toISOString() ?? null,
      createdById: credential.createdById,
      createdAt: credential.createdAt.toISOString(),
      updatedAt: credential.updatedAt.toISOString(),
      namespace: credential.namespace,
    };
  }
}
