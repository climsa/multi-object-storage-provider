import { z } from "zod";

export const migrationCreateRequestSchema = z.object({
  namespaceId: z.string().uuid(),
  sourceBucketConnectionId: z.string().uuid(),
  targetBucketConnectionId: z.string().uuid(),
}).strict().refine((value) => value.sourceBucketConnectionId !== value.targetBucketConnectionId, {
  message: "source and target buckets must differ",
  path: ["targetBucketConnectionId"],
});

export const migrationControlRequestSchema = z.object({
  action: z.enum(["start", "pause", "cancel"]),
}).strict();

export type MigrationCreateRequest = z.infer<typeof migrationCreateRequestSchema>;
export type MigrationControlRequest = z.infer<typeof migrationControlRequestSchema>;
