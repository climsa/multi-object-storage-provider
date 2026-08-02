import { z } from "zod";

const postgresBigIntStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer")
  .refine((value) => BigInt(value) <= 9223372036854775807n, {
    message: "must fit in a PostgreSQL BIGINT",
  });
const proxyMaxObjectSizeSchema = postgresBigIntStringSchema.refine(
  (value) => BigInt(value) <= 1_073_741_824n,
  { message: "proxy max object size cannot exceed 1 GiB" },
);

export const platformSettingKeySchema = z.enum([
  "maintenance_mode",
  "default_quota_bytes",
  "default_max_object_size_bytes",
  "default_transfer_mode",
  "proxy_max_object_size_bytes",
  "proxy_transfer_timeout_seconds",
  "storage_max_in_flight",
  "migration_max_concurrent_per_provider",
  "migration_retry_delay_seconds",
  "provider_health_check_interval_seconds",
]);

export const platformSettingsValuesSchema = z
  .object({
    maintenance_mode: z.boolean().optional(),
    default_quota_bytes: postgresBigIntStringSchema.optional(),
    default_max_object_size_bytes: postgresBigIntStringSchema.nullable().optional(),
    default_transfer_mode: z.enum(["DIRECT", "PROXIED"]).optional(),
    proxy_max_object_size_bytes: proxyMaxObjectSizeSchema.optional(),
    proxy_transfer_timeout_seconds: z.number().int().min(10).max(300).optional(),
    storage_max_in_flight: z.number().int().min(1).max(10_000).optional(),
    migration_max_concurrent_per_provider: z.number().int().min(1).max(20).optional(),
    migration_retry_delay_seconds: z.number().int().min(1).max(86_400).optional(),
    provider_health_check_interval_seconds: z.number().int().min(5).max(86_400).optional(),
  })
  .strict()
  .refine((values) => Object.keys(values).length > 0, {
    message: "At least one platform setting must be provided",
  });

export const platformSettingsUpdateRequestSchema = z
  .object({
    values: platformSettingsValuesSchema,
    expectedVersions: z.record(z.string(), z.number().int().min(0).max(2_147_483_647)).optional(),
  })
  .strict();

export const platformSettingResponseSchema = z.object({
  key: platformSettingKeySchema,
  value: z.unknown(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  updatedBy: z.object({ id: z.string().uuid(), email: z.string().email() }).nullable(),
});

export const platformOrganizationQuerySchema = z
  .object({
    limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  })
  .strict()
  .transform((input) => ({ limit: input.limit ?? 100 }));

export type PlatformSettingKey = z.infer<typeof platformSettingKeySchema>;
export type PlatformSettingsValues = z.infer<typeof platformSettingsValuesSchema>;
export type PlatformSettingsUpdateRequest = z.infer<typeof platformSettingsUpdateRequestSchema>;
export type PlatformOrganizationQuery = z.infer<typeof platformOrganizationQuerySchema>;
