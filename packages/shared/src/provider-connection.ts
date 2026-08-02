import { z } from "zod";

export const providerTypeSchema = z.enum([
  "AWS_S3",
  "CLOUDFLARE_R2",
  "BACKBLAZE_B2",
  "MINIO",
  "GENERIC_S3",
]);

export const addressingModeSchema = z.enum([
  "AUTO",
  "VIRTUAL_HOSTED",
  "PATH_STYLE",
]);

export const providerConnectionCreateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    type: providerTypeSchema,
    endpoint: z.string().trim().url().max(2048),
    region: z.string().trim().min(1).max(100),
    addressingMode: addressingModeSchema.default("AUTO"),
    accessKeyId: z.string().min(1).max(512),
    secretAccessKey: z.string().min(1).max(4096),
    sessionToken: z.string().min(1).max(8192).optional(),
  })
  .strict();

export const providerConnectionTestRequestSchema = z
  .object({
    bucketName: z.string().trim().min(3).max(255).optional(),
  })
  .strict();

export const providerConnectionUpdateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    endpoint: z.string().trim().url().max(2048).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    addressingMode: addressingModeSchema.optional(),
    accessKeyId: z.string().min(1).max(512).optional(),
    secretAccessKey: z.string().min(1).max(4096).optional(),
    sessionToken: z.string().min(1).max(8192).nullable().optional(),
  })
  .strict()
  .refine(
    (input) => {
      const credentialUpdate =
        input.accessKeyId !== undefined ||
        input.secretAccessKey !== undefined ||
        input.sessionToken !== undefined;
      return (
        Object.keys(input).length > 0 &&
        (!credentialUpdate ||
          (input.accessKeyId !== undefined && input.secretAccessKey !== undefined))
      );
    },
    { message: "Provider credential updates require accessKeyId and secretAccessKey" },
  );

export type ProviderConnectionCreateRequest = z.infer<
  typeof providerConnectionCreateRequestSchema
>;
export type ProviderConnectionTestRequest = z.infer<
  typeof providerConnectionTestRequestSchema
>;
export type ProviderConnectionUpdateRequest = z.infer<
  typeof providerConnectionUpdateRequestSchema
>;
