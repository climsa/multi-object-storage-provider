import { z } from "zod";

import { permissionKeys } from "./permissions.js";

export const organizationUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const memberStatusUpdateRequestSchema = z
  .object({
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .strict();

export const memberAddRequestSchema = z
  .object({
    email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    roleId: z.string().uuid().optional(),
  })
  .strict();

export const roleAssignmentRequestSchema = z
  .object({
    roleId: z.string().uuid(),
  })
  .strict();

const rolePermissionKeysSchema = z
  .array(z.enum(permissionKeys))
  .max(permissionKeys.length)
  .transform((keys) => [...new Set(keys)]);

export const roleCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    permissionKeys: rolePermissionKeysSchema.default([]),
  })
  .strict();

export const roleUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    permissionKeys: rolePermissionKeysSchema.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.permissionKeys !== undefined, {
    message: "At least one role field must be provided",
  });

const activityLogCursorSchema = z
  .string()
  .regex(/^\d{1,20}$/)
  .optional();

const activityLogLimitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

export const activityLogQuerySchema = z
  .object({
    cursor: activityLogCursorSchema,
    limit: activityLogLimitSchema.optional(),
    action: z.string().trim().min(1).max(120).optional(),
    entityType: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .transform((input) => ({ ...input, limit: input.limit ?? 50 }));

export type OrganizationUpdateRequest = z.infer<
  typeof organizationUpdateRequestSchema
>;
export type MemberStatusUpdateRequest = z.infer<
  typeof memberStatusUpdateRequestSchema
>;
export type MemberAddRequest = z.infer<typeof memberAddRequestSchema>;
export type RoleAssignmentRequest = z.infer<typeof roleAssignmentRequestSchema>;
export type RoleCreateRequest = z.infer<typeof roleCreateRequestSchema>;
export type RoleUpdateRequest = z.infer<typeof roleUpdateRequestSchema>;
export type ActivityLogQuery = z.infer<typeof activityLogQuerySchema>;
