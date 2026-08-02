import type { Prisma, PrismaClient } from "@mosp/db";
import type {
  NamespaceCreateRequest,
  NamespaceUpdateRequest,
  PlacementPolicyUpdateRequest,
  PlacementTargetCreateRequest,
} from "@mosp/shared";

export interface NamespaceActionMetadata {
  actorId: string;
  requestId: string;
}

export interface PlacementTargetSummary {
  bucketConnectionId: string;
  configuredCapacityBytes: string | null;
  createdAt: string;
  enabled: boolean;
  id: string;
  priorityTier: number;
  thresholdPercent: number;
  updatedAt: string;
  weight: number;
}

export interface PlacementPolicySummary {
  createdAt: string;
  id: string;
  status: string;
  strategy: string;
  targets: PlacementTargetSummary[];
  updatedAt: string;
}

export interface NamespaceSummary {
  createdAt: string;
  defaultTransferMode: string;
  id: string;
  maxObjectSizeBytes: string | null;
  name: string;
  placementPolicy: PlacementPolicySummary | null;
  quotaBytes: string;
  slug: string;
  status: string;
  updatedAt: string;
  versioningMode: string;
}

export class NamespaceNotFound extends Error {}
export class NamespaceMustBeDisabled extends Error {}
export class PlacementBucketNotFound extends Error {}

const namespaceInclude = {
  placementPolicy: {
    include: {
      targets: {
        orderBy: [{ priorityTier: "asc" as const }, { createdAt: "asc" as const }],
      },
    },
  },
};

export class NamespaceService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(organizationId: string): Promise<NamespaceSummary[]> {
    const namespaces = await this.database.virtualNamespace.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: namespaceInclude,
    });
    return namespaces.map((namespace) => this.toSummary(namespace));
  }

  public async get(
    organizationId: string,
    namespaceId: string,
  ): Promise<NamespaceSummary> {
    const namespace = await this.database.virtualNamespace.findFirst({
      where: { id: namespaceId, organizationId },
      include: namespaceInclude,
    });
    if (!namespace) throw new NamespaceNotFound();
    return this.toSummary(namespace);
  }

  public async create(
    organizationId: string,
    input: NamespaceCreateRequest,
    metadata: NamespaceActionMetadata,
  ): Promise<NamespaceSummary> {
    const namespace = await this.database.$transaction(async (transaction) => {
      const created = await transaction.virtualNamespace.create({
        data: {
          organizationId,
          name: input.name,
          slug: input.slug,
          quotaBytes: BigInt(input.quotaBytes),
          maxObjectSizeBytes:
            input.maxObjectSizeBytes === undefined || input.maxObjectSizeBytes === null
              ? null
              : BigInt(input.maxObjectSizeBytes),
          defaultTransferMode: input.defaultTransferMode,
          versioningMode: input.versioningMode,
        },
      });
      await transaction.placementPolicy.create({
        data: {
          namespaceId: created.id,
          organizationId,
          strategy: "PRIORITY_WEIGHTED",
          status: "ACTIVE",
        },
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "namespaces.create",
        entityId: created.id,
        metadata: { slug: created.slug },
      });
      return transaction.virtualNamespace.findFirstOrThrow({
        where: { id: created.id, organizationId },
        include: namespaceInclude,
      });
    });

    return this.toSummary(namespace);
  }

  public async update(
    organizationId: string,
    namespaceId: string,
    input: NamespaceUpdateRequest,
    metadata: NamespaceActionMetadata,
  ): Promise<NamespaceSummary> {
    const namespace = await this.database.$transaction(async (transaction) => {
      const current = await transaction.virtualNamespace.findFirst({
        where: { id: namespaceId, organizationId },
        select: { id: true },
      });
      if (!current) throw new NamespaceNotFound();

      await transaction.virtualNamespace.updateMany({
        where: { id: namespaceId, organizationId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.quotaBytes !== undefined
            ? { quotaBytes: BigInt(input.quotaBytes) }
            : {}),
          ...(input.maxObjectSizeBytes !== undefined
            ? {
                maxObjectSizeBytes:
                  input.maxObjectSizeBytes === null
                    ? null
                    : BigInt(input.maxObjectSizeBytes),
              }
            : {}),
          ...(input.defaultTransferMode !== undefined
            ? { defaultTransferMode: input.defaultTransferMode }
            : {}),
          ...(input.versioningMode !== undefined
            ? { versioningMode: input.versioningMode }
            : {}),
        },
      });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "namespaces.update",
        entityId: namespaceId,
        metadata: {
          fields: Object.keys(input),
        },
      });
      return transaction.virtualNamespace.findFirstOrThrow({
        where: { id: namespaceId, organizationId },
        include: namespaceInclude,
      });
    });

    return this.toSummary(namespace);
  }

  public async delete(
    organizationId: string,
    namespaceId: string,
    metadata: NamespaceActionMetadata,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const namespace = await transaction.virtualNamespace.findFirst({
        where: { id: namespaceId, organizationId },
        select: { id: true, status: true },
      });
      if (!namespace) throw new NamespaceNotFound();
      if (namespace.status !== "DISABLED") throw new NamespaceMustBeDisabled();

      await transaction.virtualNamespace.delete({ where: { id: namespaceId } });
      await this.writeActivity(transaction, organizationId, metadata, {
        action: "namespaces.delete",
        entityId: namespaceId,
        metadata: { deleted: true },
      });
    });
  }

  public async addTarget(
    organizationId: string,
    namespaceId: string,
    input: PlacementTargetCreateRequest,
    metadata: NamespaceActionMetadata,
  ): Promise<NamespaceSummary> {
    return this.updatePolicy(
      organizationId,
      namespaceId,
      { strategy: "PRIORITY_WEIGHTED", status: "ACTIVE", targets: [input] },
      metadata,
      true,
    );
  }

  public async updatePolicy(
    organizationId: string,
    namespaceId: string,
    input: PlacementPolicyUpdateRequest,
    metadata: NamespaceActionMetadata,
    appendTarget = false,
  ): Promise<NamespaceSummary> {
    const namespace = await this.database.$transaction(async (transaction) => {
      const namespaceExists = await transaction.virtualNamespace.findFirst({
        where: { id: namespaceId, organizationId },
        select: { id: true },
      });
      if (!namespaceExists) throw new NamespaceNotFound();

      const targets = input.targets ?? [];
      const targetBucketIds = [...new Set(targets.map((target) => target.bucketConnectionId))];
      if (targetBucketIds.length > 0) {
        const buckets = await transaction.bucketConnection.findMany({
          where: { organizationId, id: { in: targetBucketIds } },
          select: { id: true },
        });
        if (buckets.length !== targetBucketIds.length) {
          throw new PlacementBucketNotFound();
        }
      }

      let policy = await transaction.placementPolicy.findFirst({
        where: { namespaceId, organizationId },
        select: { id: true },
      });
      if (!policy) {
        policy = await transaction.placementPolicy.create({
          data: {
            namespaceId,
            organizationId,
            strategy: input.strategy ?? "PRIORITY_WEIGHTED",
            status: input.status ?? "ACTIVE",
          },
          select: { id: true },
        });
      } else if (!appendTarget) {
        await transaction.placementPolicy.update({
          where: { id: policy.id },
          data: {
            ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
          },
        });
      }

      if (input.targets !== undefined) {
        if (appendTarget) {
          await transaction.placementTarget.create({
            data: this.targetData(policy.id, organizationId, targets[0]!),
          });
        } else {
          await transaction.placementTarget.deleteMany({
            where: { policyId: policy.id, organizationId },
          });
          if (targets.length > 0) {
            await transaction.placementTarget.createMany({
              data: targets.map((target) =>
                this.targetData(policy.id, organizationId, target),
              ),
            });
          }
        }
      }

      await this.writeActivity(transaction, organizationId, metadata, {
        action: appendTarget ? "placement_targets.create" : "placement_policies.update",
        entityId: policy.id,
        metadata: {
          targetCount: input.targets?.length ?? 0,
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      return transaction.virtualNamespace.findFirstOrThrow({
        where: { id: namespaceId, organizationId },
        include: namespaceInclude,
      });
    });

    return this.toSummary(namespace);
  }

  private targetData(
    policyId: string,
    organizationId: string,
    target: PlacementTargetCreateRequest,
  ) {
    return {
      policyId,
      organizationId,
      bucketConnectionId: target.bucketConnectionId,
      priorityTier: target.priorityTier,
      weight: target.weight,
      configuredCapacityBytes:
        target.configuredCapacityBytes === undefined || target.configuredCapacityBytes === null
          ? null
          : BigInt(target.configuredCapacityBytes),
      thresholdPercent: target.thresholdPercent,
      enabled: target.enabled,
    };
  }

  private async writeActivity(
    transaction: Pick<PrismaClient, "activityLog">,
    organizationId: string,
    metadata: NamespaceActionMetadata,
    input: { action: string; entityId: string; metadata: Prisma.InputJsonValue },
  ): Promise<void> {
    await transaction.activityLog.create({
      data: {
        organizationId,
        actorId: metadata.actorId,
        action: input.action,
        entityType: input.action.startsWith("placement_")
          ? "PlacementPolicy"
          : "VirtualNamespace",
        entityId: input.entityId,
        requestId: metadata.requestId,
        metadata: input.metadata,
      },
    });
  }

  private toSummary(namespace: {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    status: string;
    quotaBytes: bigint;
    maxObjectSizeBytes: bigint | null;
    defaultTransferMode: string;
    versioningMode: string;
    createdAt: Date;
    updatedAt: Date;
    placementPolicy: {
      id: string;
      strategy: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
      targets: Array<{
        id: string;
        bucketConnectionId: string;
        priorityTier: number;
        weight: number;
        configuredCapacityBytes: bigint | null;
        thresholdPercent: number;
        enabled: boolean;
        createdAt: Date;
        updatedAt: Date;
      }>;
    } | null;
  }): NamespaceSummary {
    return {
      id: namespace.id,
      name: namespace.name,
      slug: namespace.slug,
      status: namespace.status,
      quotaBytes: namespace.quotaBytes.toString(),
      maxObjectSizeBytes: namespace.maxObjectSizeBytes?.toString() ?? null,
      defaultTransferMode: namespace.defaultTransferMode,
      versioningMode: namespace.versioningMode,
      createdAt: namespace.createdAt.toISOString(),
      updatedAt: namespace.updatedAt.toISOString(),
      placementPolicy: namespace.placementPolicy
        ? {
            id: namespace.placementPolicy.id,
            strategy: namespace.placementPolicy.strategy,
            status: namespace.placementPolicy.status,
            createdAt: namespace.placementPolicy.createdAt.toISOString(),
            updatedAt: namespace.placementPolicy.updatedAt.toISOString(),
            targets: namespace.placementPolicy.targets.map((target) => ({
              id: target.id,
              bucketConnectionId: target.bucketConnectionId,
              priorityTier: target.priorityTier,
              weight: target.weight,
              configuredCapacityBytes: target.configuredCapacityBytes?.toString() ?? null,
              thresholdPercent: target.thresholdPercent,
              enabled: target.enabled,
              createdAt: target.createdAt.toISOString(),
              updatedAt: target.updatedAt.toISOString(),
            })),
          }
        : null,
    };
  }
}
