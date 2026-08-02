import { z } from "zod";

const expirationSchema = z.string().datetime({ offset: true }).nullable().optional();

export const apiCredentialCreateRequestSchema = z
  .object({
    namespaceId: z.string().uuid(),
    expiresAt: expirationSchema,
  })
  .strict();

export const apiCredentialRotateRequestSchema = z
  .object({
    expiresAt: expirationSchema,
  })
  .strict();

export type ApiCredentialCreateRequest = z.infer<
  typeof apiCredentialCreateRequestSchema
>;
export type ApiCredentialRotateRequest = z.infer<
  typeof apiCredentialRotateRequestSchema
>;
