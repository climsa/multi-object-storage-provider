import { Prisma, type PrismaClient } from "@mosp/db";
import type {
  PlatformOrganizationQuery,
  PlatformSettingKey,
  PlatformSettingsUpdateRequest,
} from "@mosp/shared";

export const DEFAULT_PLATFORM_SETTINGS: Record<PlatformSettingKey, unknown> = {
  maintenance_mode: false,
  default_quota_bytes: "10737418240",
  default_max_object_size_bytes: null,
  default_transfer_mode: "DIRECT",
  proxy_max_object_size_bytes: "1073741824",
  proxy_transfer_timeout_seconds: 300,
  storage_max_in_flight: 100,
  migration_max_concurrent_per_provider: 2,
  migration_retry_delay_seconds: 60,
  provider_health_check_interval_seconds: 60,
};

export interface PlatformActionMetadata {
  actorId: string;
  requestId: string;
}

export interface PlatformOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

export interface PlatformSettingSummary {
  key: PlatformSettingKey;
  value: unknown;
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

export class PlatformSettingVersionConflict extends Error {}

export class PlatformService {
  public constructor(private readonly database: PrismaClient) {}

  public async getNumberSetting(key: PlatformSettingKey, fallback: number): Promise<number> {
    const setting = await this.database.platformSetting.findUnique({ where: { key }, select: { value: true } });
    return typeof setting?.value === "number" && Number.isFinite(setting.value) ? setting.value : fallback;
  }

  public async getBigIntSetting(key: PlatformSettingKey, fallback: bigint): Promise<bigint> {
    const setting = await this.database.platformSetting.findUnique({ where: { key }, select: { value: true } });
    if (typeof setting?.value !== "string" || !/^\d+$/.test(setting.value)) return fallback;
    try {
      return BigInt(setting.value);
    } catch {
      return fallback;
    }
  }

  public async listOrganizations(
    input: PlatformOrganizationQuery,
  ): Promise<PlatformOrganizationSummary[]> {
    const organizations = await this.database.organization.findMany({
      orderBy: { createdAt: "desc" },
      take: input.limit,
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
    });
    return organizations.map((organization) => ({
      ...organization,
      createdAt: organization.createdAt.toISOString(),
    }));
  }

  public async getSettings(): Promise<PlatformSettingSummary[]> {
    const stored = await this.database.platformSetting.findMany({
      orderBy: { key: "asc" },
      include: { updatedBy: { select: { id: true, email: true } } },
    });
    const storedByKey = new Map(stored.map((setting) => [setting.key, setting]));
    return Object.keys(DEFAULT_PLATFORM_SETTINGS)
      .sort()
      .map((key) => {
        const setting = storedByKey.get(key);
        if (!setting) {
          return {
            key: key as PlatformSettingKey,
            value: DEFAULT_PLATFORM_SETTINGS[key as PlatformSettingKey],
            version: 0,
            updatedAt: null,
            updatedBy: null,
          };
        }
        return this.toSettingSummary(setting);
      });
  }

  public async updateSettings(
    input: PlatformSettingsUpdateRequest,
    metadata: PlatformActionMetadata,
  ): Promise<PlatformSettingSummary[]> {
    await this.database.$transaction(async (transaction) => {
      for (const [rawKey, value] of Object.entries(input.values)) {
        if (value === undefined) continue;
        const key = rawKey as PlatformSettingKey;
        const current = await transaction.platformSetting.findUnique({ where: { key } });
        const expectedVersion = input.expectedVersions?.[key];
        const currentVersion = current?.version ?? 0;
        if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
          throw new PlatformSettingVersionConflict();
        }

        const nextVersion = currentVersion + 1;
        const jsonValue = value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
        if (current) {
          await transaction.platformSetting.update({
            where: { id: current.id },
            data: { value: jsonValue, version: nextVersion, updatedById: metadata.actorId },
          });
        } else {
          await transaction.platformSetting.create({
            data: {
              key,
              value: jsonValue,
              version: nextVersion,
              updatedById: metadata.actorId,
            },
          });
        }

        await transaction.activityLog.create({
          data: {
            organizationId: null,
            actorId: metadata.actorId,
            action: "platform.settings.update",
            entityType: "PlatformSetting",
            entityId: key,
            requestId: metadata.requestId,
            metadata: { key, changed: true },
          },
        });
      }
    });

    return this.getSettings();
  }

  private toSettingSummary(setting: {
    key: string;
    value: unknown;
    version: number;
    updatedAt: Date;
    updatedBy: { id: string; email: string } | null;
  }): PlatformSettingSummary {
    return {
      key: setting.key as PlatformSettingKey,
      value: setting.value,
      version: setting.version,
      updatedAt: setting.updatedAt.toISOString(),
      updatedBy: setting.updatedBy,
    };
  }
}
