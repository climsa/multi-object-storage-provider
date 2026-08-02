import { z } from "zod";

export const bucketImportRequestSchema = z
  .object({
    bucketName: z.string().trim().min(3).max(255),
    providerConnectionId: z.string().uuid(),
  })
  .strict();

export const bucketConnectionStatusUpdateRequestSchema = z
  .object({
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .strict();

export type BucketImportRequest = z.infer<typeof bucketImportRequestSchema>;
export type BucketConnectionStatusUpdateRequest = z.infer<
  typeof bucketConnectionStatusUpdateRequestSchema
>;
