import { randomInt } from "node:crypto";

import { Prisma, type PrismaClient } from "@mosp/db";

export interface PlacementTargetSelection {
  bucketConnection: {
    bucketName: string;
    id: string;
    providerConnectionId: string;
  };
  id: string;
}

type PlacementCandidate = PlacementTargetSelection & {
  configuredCapacityBytes: bigint | null;
  priorityTier: number;
  thresholdPercent: number;
  weight: number;
};

/** Selects a healthy target without allowing a provider to exceed its policy capacity. */
export class PlacementService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly chooseRandom: (maxExclusive: number) => number = (max) => randomInt(max),
  ) {}

  public async selectTarget(
    organizationId: string,
    namespaceId: string,
    sizeBytes: bigint,
  ): Promise<PlacementTargetSelection | null> {
    const candidates = await this.database.placementTarget.findMany({
      where: {
        organizationId,
        enabled: true,
        policy: { organizationId, namespaceId, status: "ACTIVE" },
        bucketConnection: {
          organizationId,
          status: "ACTIVE",
          providerConnection: { organizationId, status: "HEALTHY" },
        },
      },
      orderBy: [{ priorityTier: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        priorityTier: true,
        weight: true,
        configuredCapacityBytes: true,
        thresholdPercent: true,
        bucketConnection: {
          select: { id: true, bucketName: true, providerConnectionId: true },
        },
      },
    });
    if (candidates.length === 0) return null;

    const eligible: PlacementCandidate[] = [];
    for (const candidate of candidates) {
      const usedBytes = await this.targetUsedBytes(
        this.database,
        organizationId,
        candidate.bucketConnection.id,
      );
      if (
        candidate.configuredCapacityBytes !== null &&
        usedBytes + sizeBytes >
          (candidate.configuredCapacityBytes * BigInt(candidate.thresholdPercent)) / 100n
      ) {
        continue;
      }
      eligible.push(candidate);
    }
    if (eligible.length === 0) return null;

    const lowestTier = Math.min(...eligible.map((candidate) => candidate.priorityTier));
    const tier = eligible.filter((candidate) => candidate.priorityTier === lowestTier);
    const totalWeight = tier.reduce((total, candidate) => total + candidate.weight, 0);
    let pick = this.chooseRandom(totalWeight);
    for (const candidate of tier) {
      if (pick < candidate.weight) {
        return {
          id: candidate.id,
          bucketConnection: candidate.bucketConnection,
        };
      }
      pick -= candidate.weight;
    }
    const fallback = tier[tier.length - 1]!;
    return { id: fallback.id, bucketConnection: fallback.bucketConnection };
  }

  public async assertTargetCapacity(
    transaction: Pick<Prisma.TransactionClient, "$queryRaw">,
    organizationId: string,
    namespaceId: string,
    targetId: string,
    sizeBytes: bigint,
  ): Promise<boolean> {
    const targets = await transaction.$queryRaw<Array<{
      bucketConnectionId: string;
      configuredCapacityBytes: bigint | null;
      thresholdPercent: number;
    }>>(Prisma.sql`
      SELECT p."bucketConnectionId", p."configuredCapacityBytes", p."thresholdPercent"
      FROM "PlacementTarget" p
      INNER JOIN "PlacementPolicy" policy ON policy."id" = p."policyId" AND policy."organizationId" = p."organizationId"
      INNER JOIN "BucketConnection" bucket ON bucket."id" = p."bucketConnectionId" AND bucket."organizationId" = p."organizationId"
      INNER JOIN "ProviderConnection" provider ON provider."id" = bucket."providerConnectionId" AND provider."organizationId" = bucket."organizationId"
      WHERE p."id" = ${targetId}
        AND p."organizationId" = ${organizationId}
        AND p."enabled" = true
        AND policy."namespaceId" = ${namespaceId}
        AND policy."status" = 'ACTIVE'
        AND bucket."status" = 'ACTIVE'
        AND provider."status" = 'HEALTHY'
      FOR UPDATE OF p
    `);
    const target = targets[0];
    if (!target) return false;
    if (target.configuredCapacityBytes === null) return true;
    const usedBytes = await this.targetUsedBytes(
      transaction,
      organizationId,
      target.bucketConnectionId,
    );
    return usedBytes + sizeBytes <=
      (target.configuredCapacityBytes * BigInt(target.thresholdPercent)) / 100n;
  }

  private async targetUsedBytes(
    database: Pick<PrismaClient, "$queryRaw">,
    organizationId: string,
    bucketConnectionId: string,
  ): Promise<bigint> {
    const rows = await database.$queryRaw<Array<{ usedBytes: bigint | number | null }>>(
      Prisma.sql`
        SELECT
          COALESCE(SUM("ObjectRecord"."sizeBytes"), 0)::bigint
          + COALESCE((
            SELECT SUM("UploadSession"."reservedBytes")
            FROM "UploadSession"
            WHERE "UploadSession"."organizationId" = ${organizationId}
              AND "UploadSession"."bucketConnectionId" = ${bucketConnectionId}
              AND "UploadSession"."state" IN ('INITIATED', 'COMPLETING')
          ), 0)::bigint AS "usedBytes"
        FROM "ObjectLocation"
        INNER JOIN "ObjectRecord"
          ON "ObjectRecord"."id" = "ObjectLocation"."objectRecordId"
         AND "ObjectRecord"."organizationId" = "ObjectLocation"."organizationId"
        WHERE "ObjectLocation"."organizationId" = ${organizationId}
          AND "ObjectLocation"."bucketConnectionId" = ${bucketConnectionId}
          AND "ObjectLocation"."state" = 'ACTIVE'
          AND "ObjectRecord"."state" = 'AVAILABLE'
      `,
    );
    const value = rows[0]?.usedBytes;
    return typeof value === "bigint" ? value : BigInt(value ?? 0);
  }
}
