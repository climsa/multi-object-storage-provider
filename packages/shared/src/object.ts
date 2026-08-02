import { z } from "zod";

function assertSafeObjectPath(value: string): string {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Object key contains an unsafe path segment");
  }
  return value;
}

function safeObjectPathSchema(maxLength: number, minimumLength: number) {
  return z
    .string()
    .min(minimumLength)
    .max(maxLength)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
    .superRefine((value, context) => {
      try {
        assertSafeObjectPath(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid object path",
        });
      }
    });
}

export const objectKeySchema = safeObjectPathSchema(2048, 1);
export const objectListPrefixSchema = safeObjectPathSchema(2048, 0);

const objectListLimitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

export const objectListQuerySchema = z
  .object({
    prefix: objectListPrefixSchema.optional(),
    limit: objectListLimitSchema.optional(),
  })
  .strict()
  .transform((input) => ({ ...input, limit: input.limit ?? 100 }));

export type ObjectListQuery = z.infer<typeof objectListQuerySchema>;
