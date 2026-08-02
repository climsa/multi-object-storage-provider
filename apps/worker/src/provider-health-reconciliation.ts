import type { PrismaClient } from "@mosp/db";
import type { S3ProviderAdapter } from "@mosp/provider-s3";

export interface ProviderHealthReconciliationOptions {
  batchSize?: number;
  now?: Date;
  minIntervalMs?: number;
}

export interface ProviderHealthReconciliationResult {
  healthy: number;
  unhealthy: number;
}

type ProviderAdapterResolver = {
  adapterFor(organizationId: string, providerId: string): Promise<S3ProviderAdapter>;
};

const MAX_BATCH_SIZE = 100;

export class ProviderHealthReconciliationService {
  public constructor(
    private readonly database: PrismaClient,
    private readonly providerService: ProviderAdapterResolver,
  ) {}

  public async reconcile(
    options: ProviderHealthReconciliationOptions = {},
  ): Promise<ProviderHealthReconciliationResult> {
    const batchSize = this.safeBatchSize(options.batchSize ?? 20);
    const now = options.now ?? new Date();
    const minIntervalMs = this.safeInterval(options.minIntervalMs ?? 0);
    const providers = await this.database.providerConnection.findMany({
      where: {
        status: { not: "DISABLED" },
        ...(minIntervalMs > 0
          ? {
              OR: [
                { lastHealthCheckedAt: null },
                { lastHealthCheckedAt: { lte: new Date(now.getTime() - minIntervalMs) } },
              ],
            }
          : {}),
      },
      orderBy: { lastHealthCheckedAt: "asc" },
      take: batchSize,
      select: { id: true, organizationId: true },
    });

    let healthy = 0;
    let unhealthy = 0;
    for (const provider of providers) {
      try {
        const adapter = await this.providerService.adapterFor(
          provider.organizationId,
          provider.id,
        );
        const result = await adapter.testConnection();
        await this.recordHealthy(provider.organizationId, provider.id, now, result);
        healthy += 1;
      } catch (error) {
        await this.recordUnhealthy(
          provider.organizationId,
          provider.id,
          now,
          providerHealthErrorCode(error),
        );
        unhealthy += 1;
      }
    }

    return { healthy, unhealthy };
  }

  private async recordHealthy(
    organizationId: string,
    providerId: string,
    checkedAt: Date,
    result: { bucketNames: string[]; capabilities: Array<{ capability: string; supported: boolean; details?: Record<string, string> }> },
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.providerConnection.updateMany({
        where: { id: providerId, organizationId, status: { not: "DISABLED" } },
        data: {
          status: "HEALTHY",
          lastHealthCheckedAt: checkedAt,
          healthDetails: { code: "HEALTHY", bucketCount: result.bucketNames.length },
        },
      });
      if (changed.count !== 1) return;
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
            testedAt: checkedAt,
          },
          update: {
            supported: capability.supported,
            ...(capability.details ? { details: capability.details } : {}),
            testedAt: checkedAt,
          },
        });
      }
    });
  }

  private async recordUnhealthy(
    organizationId: string,
    providerId: string,
    checkedAt: Date,
    code: string,
  ): Promise<void> {
    await this.database.providerConnection.updateMany({
      where: { id: providerId, organizationId, status: { not: "DISABLED" } },
      data: {
        status: "UNHEALTHY",
        lastHealthCheckedAt: checkedAt,
        healthDetails: { code },
      },
    });
  }

  private safeBatchSize(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}`);
    }
    return value;
  }

  private safeInterval(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 86_400_000) {
      throw new RangeError("minIntervalMs must be an integer from 0 to 86400000");
    }
    return value;
  }
}

export function providerHealthErrorCode(error: unknown): string {
  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
      : undefined;
  if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
  if (status === 404) return "PROVIDER_ENDPOINT_NOT_FOUND";
  if (status === 408 || status === 429) return "PROVIDER_RETRYABLE";
  if (typeof status === "number" && status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_HEALTH_CHECK_FAILED";
}
