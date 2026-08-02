import { z } from "zod";

const maxPostgresBigInt = 9223372036854775807n;

const postgresBigIntStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer")
  .refine((value) => BigInt(value) <= maxPostgresBigInt, {
    message: "must fit in a PostgreSQL BIGINT",
  });

const namespaceNameSchema = z.string().trim().min(1).max(200);
const namespaceSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/);

export const namespaceStatusSchema = z.enum(["ACTIVE", "DISABLED"]);
export const namespaceTransferModeSchema = z.enum(["DIRECT", "PROXIED"]);
export const namespaceVersioningModeSchema = z.enum(["DISABLED"]);
export const placementPolicyStrategySchema = z.enum(["PRIORITY_WEIGHTED"]);
export const placementPolicyStatusSchema = z.enum(["ACTIVE", "DISABLED"]);

const placementTargetInputSchema = z
  .object({
    bucketConnectionId: z.string().uuid(),
    priorityTier: z.number().int().min(0).max(2147483647).default(0),
    weight: z.number().int().min(1).max(2147483647).default(100),
    configuredCapacityBytes: postgresBigIntStringSchema.nullable().optional(),
    thresholdPercent: z.number().int().min(0).max(100).default(100),
    enabled: z.boolean().default(true),
  })
  .strict();

export const namespaceCreateRequestSchema = z
  .object({
    name: namespaceNameSchema,
    slug: namespaceSlugSchema,
    quotaBytes: postgresBigIntStringSchema,
    maxObjectSizeBytes: postgresBigIntStringSchema.nullable().optional(),
    defaultTransferMode: namespaceTransferModeSchema.default("DIRECT"),
    versioningMode: namespaceVersioningModeSchema.default("DISABLED"),
  })
  .strict();

export const namespaceUpdateRequestSchema = z
  .object({
    name: namespaceNameSchema.optional(),
    slug: namespaceSlugSchema.optional(),
    status: namespaceStatusSchema.optional(),
    quotaBytes: postgresBigIntStringSchema.optional(),
    maxObjectSizeBytes: postgresBigIntStringSchema.nullable().optional(),
    defaultTransferMode: namespaceTransferModeSchema.optional(),
    versioningMode: namespaceVersioningModeSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one namespace field must be provided",
  });

export const placementTargetCreateRequestSchema = placementTargetInputSchema;

export const placementPolicyUpdateRequestSchema = z
  .object({
    strategy: placementPolicyStrategySchema.default("PRIORITY_WEIGHTED"),
    status: placementPolicyStatusSchema.default("ACTIVE"),
    targets: z.array(placementTargetInputSchema).max(100).optional(),
  })
  .strict();

export type NamespaceCreateRequest = z.infer<typeof namespaceCreateRequestSchema>;
export type NamespaceUpdateRequest = z.infer<typeof namespaceUpdateRequestSchema>;
export type PlacementTargetCreateRequest = z.infer<
  typeof placementTargetCreateRequestSchema
>;
export type PlacementPolicyUpdateRequest = z.infer<
  typeof placementPolicyUpdateRequestSchema
>;
