import { z } from "zod";

export const providerCredentialPayloadSchema = z
  .object({
    accessKeyId: z.string().min(1).max(512),
    secretAccessKey: z.string().min(1).max(4096),
    sessionToken: z.string().min(1).max(8192).optional(),
  })
  .strict();

export type ProviderCredentialPayload = z.infer<
  typeof providerCredentialPayloadSchema
>;

