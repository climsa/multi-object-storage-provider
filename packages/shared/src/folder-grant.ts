import { z } from "zod";

export const folderGrantPrincipalTypeSchema = z.enum(["ROLE", "API_CREDENTIAL"]);
export const folderGrantActionSchema = z.enum(["list", "read", "write", "delete"]);

export function normalizeFolderPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.includes("//") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Folder prefix contains an unsafe path segment");
  }
  return normalized;
}

const safePrefixSchema = z
  .string()
  .max(1024)
  .superRefine((value, context) => {
    try {
      normalizeFolderPrefix(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid folder prefix",
      });
    }
  })
  .transform(normalizeFolderPrefix);

const actionsSchema = z
  .array(folderGrantActionSchema)
  .min(1)
  .max(4)
  .transform((actions) => [...new Set(actions)]);

const expirationSchema = z.string().datetime({ offset: true }).nullable().optional();

export const folderGrantCreateRequestSchema = z
  .object({
    namespaceId: z.string().uuid(),
    principalType: folderGrantPrincipalTypeSchema,
    principalId: z.string().uuid(),
    prefix: safePrefixSchema,
    actions: actionsSchema,
    expiresAt: expirationSchema,
  })
  .strict();

export const folderGrantQuerySchema = z
  .object({
    namespaceId: z.string().uuid().optional(),
    principalType: folderGrantPrincipalTypeSchema.optional(),
    principalId: z.string().uuid().optional(),
  })
  .strict();

export type FolderGrantCreateRequest = z.infer<typeof folderGrantCreateRequestSchema>;
export type FolderGrantQuery = z.infer<typeof folderGrantQuerySchema>;
export type FolderGrantAction = z.infer<typeof folderGrantActionSchema>;
export type FolderGrantPrincipalType = z.infer<
  typeof folderGrantPrincipalTypeSchema
>;
