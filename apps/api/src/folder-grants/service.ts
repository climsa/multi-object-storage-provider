import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@mosp/db";
import {
  normalizeFolderPrefix,
  type FolderGrantAction,
  type FolderGrantCreateRequest,
  type FolderGrantPrincipalType,
  type FolderGrantQuery,
} from "@mosp/shared";

export interface FolderGrantActionMetadata {
  actorId: string;
  requestId: string;
}

export interface FolderGrantSummary {
  actions: string[];
  createdAt: string;
  createdById: string;
  expiresAt: string | null;
  id: string;
  namespace: { id: string; name: string; slug: string };
  namespaceId: string;
  prefix: string;
  principalId: string;
  principalType: string;
  updatedAt: string;
}

export class FolderGrantNotFound extends Error {}
export class FolderGrantNamespaceNotFound extends Error {}
export class FolderGrantPrincipalNotFound extends Error {}
export class FolderGrantCredentialNotActive extends Error {}
export class FolderGrantExpiryInvalid extends Error {}
export class FolderGrantPrefixInvalid extends Error {}

const grantInclude = {
  namespace: { select: { id: true, name: true, slug: true } },
};

export interface FolderAccessCheck {
  action: FolderGrantAction;
  key: string;
  namespaceId: string;
  organizationId: string;
  principalId: string;
  principalType: FolderGrantPrincipalType;
  now?: Date;
}

export class FolderGrantService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(
    organizationId: string,
    query: FolderGrantQuery,
  ): Promise<FolderGrantSummary[]> {
    const grants = await this.database.folderGrant.findMany({
      where: {
        organizationId,
        ...(query.namespaceId ? { namespaceId: query.namespaceId } : {}),
        ...(query.principalType ? { principalType: query.principalType } : {}),
        ...(query.principalId ? { principalId: query.principalId } : {}),
      },
      orderBy: [{ namespaceId: "asc" }, { prefix: "asc" }, { createdAt: "desc" }],
      include: grantInclude,
    });
    return grants.map((grant) => this.toSummary(grant));
  }

  public async create(
    organizationId: string,
    input: FolderGrantCreateRequest,
    metadata: FolderGrantActionMetadata,
  ): Promise<FolderGrantSummary> {
    const now = new Date();
    const expiresAt = this.parseExpiry(input.expiresAt, now);
    let prefix: string;
    try {
      prefix = normalizeFolderPrefix(input.prefix);
    } catch {
      throw new FolderGrantPrefixInvalid();
    }

    const grant = await this.database.$transaction(async (transaction) => {
      const namespace = await transaction.virtualNamespace.findFirst({
        where: { id: input.namespaceId, organizationId },
        select: { id: true },
      });
      if (!namespace) throw new FolderGrantNamespaceNotFound();

      await this.assertPrincipal(
        transaction,
        organizationId,
        input.namespaceId,
        input.principalType,
        input.principalId,
        now,
      );

      const created = await transaction.folderGrant.create({
        data: {
          id: randomUUID(),
          organizationId,
          namespaceId: input.namespaceId,
          principalType: input.principalType,
          principalId: input.principalId,
          prefix,
          actions: input.actions,
          expiresAt,
          createdById: metadata.actorId,
        },
        include: grantInclude,
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "folder_grants.create",
        entityId: created.id,
        metadata: {
          namespaceId: created.namespaceId,
          principalType: created.principalType,
          principalId: created.principalId,
          prefix: created.prefix,
          actions: created.actions,
        },
      });
      return created;
    });

    return this.toSummary(grant);
  }

  public async delete(
    organizationId: string,
    grantId: string,
    metadata: FolderGrantActionMetadata,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const grant = await transaction.folderGrant.findFirst({
        where: { id: grantId, organizationId },
        select: { id: true },
      });
      if (!grant) throw new FolderGrantNotFound();

      await transaction.folderGrant.delete({ where: { id: grantId } });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "folder_grants.delete",
        entityId: grantId,
        metadata: { deleted: true },
      });
    });
  }

  public async canAccess(input: FolderAccessCheck): Promise<boolean> {
    const now = input.now ?? new Date();
    const principalIsValid = await this.principalIsActive(
      input.organizationId,
      input.namespaceId,
      input.principalType,
      input.principalId,
      now,
    );
    if (!principalIsValid) return false;

    const grants = await this.database.folderGrant.findMany({
      where: {
        organizationId: input.organizationId,
        namespaceId: input.namespaceId,
        principalType: input.principalType,
        principalId: input.principalId,
        actions: { has: input.action },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { prefix: true },
    });
    return grants.some((grant) => this.prefixMatches(grant.prefix, input.key));
  }

  private async assertPrincipal(
    transaction: Pick<PrismaClient, "role" | "apiCredential">,
    organizationId: string,
    namespaceId: string,
    principalType: FolderGrantPrincipalType,
    principalId: string,
    now: Date,
  ): Promise<void> {
    if (principalType === "ROLE") {
      const role = await transaction.role.findFirst({
        where: { id: principalId, organizationId, scope: "ORGANIZATION" },
        select: { id: true },
      });
      if (!role) throw new FolderGrantPrincipalNotFound();
      return;
    }

    const credential = await transaction.apiCredential.findFirst({
      where: { id: principalId, organizationId, namespaceId, status: "ACTIVE" },
      select: { id: true, expiresAt: true },
    });
    if (!credential) throw new FolderGrantPrincipalNotFound();
    if (credential.expiresAt !== null && credential.expiresAt <= now) {
      throw new FolderGrantCredentialNotActive();
    }
  }

  private async principalIsActive(
    organizationId: string,
    namespaceId: string,
    principalType: FolderGrantPrincipalType,
    principalId: string,
    now: Date,
  ): Promise<boolean> {
    if (principalType === "ROLE") {
      const role = await this.database.role.findFirst({
        where: { id: principalId, organizationId, scope: "ORGANIZATION" },
        select: { id: true },
      });
      return role !== null;
    }

    const credential = await this.database.apiCredential.findFirst({
      where: { id: principalId, organizationId, namespaceId, status: "ACTIVE" },
      select: { expiresAt: true },
    });
    return credential !== null &&
      (credential.expiresAt === null || credential.expiresAt > now);
  }

  private parseExpiry(value: string | null | undefined, now: Date): Date | null {
    if (value === undefined || value === null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed <= now) {
      throw new FolderGrantExpiryInvalid();
    }
    return parsed;
  }

  private prefixMatches(prefix: string, key: string): boolean {
    return prefix === "" || key === prefix || key.startsWith(`${prefix}/`);
  }

  private async writeActivity(
    transaction: Pick<PrismaClient, "activityLog">,
    organizationId: string,
    metadata: FolderGrantActionMetadata,
    input: { action: string; entityId: string; metadata: Prisma.InputJsonValue },
  ): Promise<void> {
    await transaction.activityLog.create({
      data: {
        organizationId,
        actorId: metadata.actorId,
        action: input.action,
        entityType: "FolderGrant",
        entityId: input.entityId,
        requestId: metadata.requestId,
        metadata: input.metadata,
      },
    });
  }

  private toSummary(grant: {
    id: string;
    namespaceId: string;
    principalType: string;
    principalId: string;
    prefix: string;
    actions: string[];
    expiresAt: Date | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    namespace: { id: string; name: string; slug: string };
  }): FolderGrantSummary {
    return {
      id: grant.id,
      namespaceId: grant.namespaceId,
      namespace: grant.namespace,
      principalType: grant.principalType,
      principalId: grant.principalId,
      prefix: grant.prefix,
      actions: grant.actions,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      createdById: grant.createdById,
      createdAt: grant.createdAt.toISOString(),
      updatedAt: grant.updatedAt.toISOString(),
    };
  }
}
