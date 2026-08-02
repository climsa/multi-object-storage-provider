import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@mosp/db";

export interface UsageQuery {
  cursor?: string;
  limit: number;
}

export interface UsageTotals {
  activeUploadCount: number;
  egressBytes: string;
  ingressBytes: string;
  objectCount: string;
  requestCount: string;
  reservedBytes: string;
  usedBytes: string;
}

export interface NamespaceUsageSummary extends UsageTotals {
  namespaceId: string;
  name: string;
  quotaBytes: string;
  slug: string;
  status: string;
  updatedAt: string | null;
}

export interface UsagePage {
  namespaces: NamespaceUsageSummary[];
  nextCursor: string | null;
  totals: UsageTotals;
}

const usageSelect = {
  usedBytes: true,
  reservedBytes: true,
  objectCount: true,
  activeUploadCount: true,
  requestCount: true,
  ingressBytes: true,
  egressBytes: true,
  updatedAt: true,
} as const;

function bigintValue(value: bigint | null | undefined): bigint {
  return value ?? 0n;
}

function totalsFrom(values: {
  usedBytes?: bigint | null;
  reservedBytes?: bigint | null;
  objectCount?: bigint | null;
  activeUploadCount?: number | null;
  requestCount?: bigint | null;
  ingressBytes?: bigint | null;
  egressBytes?: bigint | null;
} | undefined): UsageTotals {
  return {
    usedBytes: bigintValue(values?.usedBytes).toString(),
    reservedBytes: bigintValue(values?.reservedBytes).toString(),
    objectCount: bigintValue(values?.objectCount).toString(),
    activeUploadCount: values?.activeUploadCount ?? 0,
    requestCount: bigintValue(values?.requestCount).toString(),
    ingressBytes: bigintValue(values?.ingressBytes).toString(),
    egressBytes: bigintValue(values?.egressBytes).toString(),
  };
}

export class UsageService {
  public constructor(private readonly database: PrismaClient) {}

  public async list(
    organizationId: string,
    query: UsageQuery,
  ): Promise<UsagePage> {
    const [namespaces, totals] = await Promise.all([
      this.database.virtualNamespace.findMany({
        where: { organizationId },
        orderBy: { id: "asc" },
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        take: query.limit + 1,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          quotaBytes: true,
          usageCounters: { take: 1, select: usageSelect },
        },
      }),
      this.database.usageCounter.aggregate({
        where: { organizationId },
        _sum: {
          usedBytes: true,
          reservedBytes: true,
          objectCount: true,
          activeUploadCount: true,
          requestCount: true,
          ingressBytes: true,
          egressBytes: true,
        },
      }),
    ]);

    const hasMore = namespaces.length > query.limit;
    const page = hasMore ? namespaces.slice(0, query.limit) : namespaces;
    return {
      namespaces: page.map((namespace) => {
        const counter = namespace.usageCounters[0];
        return {
          namespaceId: namespace.id,
          name: namespace.name,
          slug: namespace.slug,
          status: namespace.status,
          quotaBytes: namespace.quotaBytes.toString(),
          ...totalsFrom(counter),
          updatedAt: counter?.updatedAt.toISOString() ?? null,
        };
      }),
      nextCursor: hasMore ? page.at(-1)!.id : null,
      totals: totalsFrom(totals._sum),
    };
  }

  public async recordRequest(
    organizationId: string,
    namespaceId: string,
  ): Promise<void> {
    await this.database.usageCounter.upsert({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      create: {
        id: randomUUID(),
        organizationId,
        namespaceId,
        requestCount: 1n,
      },
      update: { requestCount: { increment: 1n } },
    });
  }

  public async recordEgress(
    organizationId: string,
    namespaceId: string,
    sizeBytes: bigint,
  ): Promise<void> {
    if (sizeBytes < 0n) throw new RangeError("sizeBytes must not be negative");
    await this.database.usageCounter.upsert({
      where: { organizationId_namespaceId: { organizationId, namespaceId } },
      create: {
        id: randomUUID(),
        organizationId,
        namespaceId,
        egressBytes: sizeBytes,
      },
      update: { egressBytes: { increment: sizeBytes } },
    });
  }

  public static toCsv(page: UsagePage): string {
    const header = [
      "namespace_id",
      "namespace_name",
      "namespace_slug",
      "status",
      "quota_bytes",
      "used_bytes",
      "reserved_bytes",
      "object_count",
      "active_upload_count",
      "request_count",
      "ingress_bytes",
      "egress_bytes",
      "updated_at",
    ];
    const rows = page.namespaces.map((namespace) => [
      namespace.namespaceId,
      namespace.name,
      namespace.slug,
      namespace.status,
      namespace.quotaBytes,
      namespace.usedBytes,
      namespace.reservedBytes,
      namespace.objectCount,
      String(namespace.activeUploadCount),
      namespace.requestCount,
      namespace.ingressBytes,
      namespace.egressBytes,
      namespace.updatedAt ?? "",
    ]);
    return [header, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\n") + "\n";
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
