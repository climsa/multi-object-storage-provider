import { z } from "zod";

import { objectKeySchema } from "./object.js";

const maxPostgresBigInt = 9223372036854775807n;
const sizeBytesSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer")
  .refine((value) => BigInt(value) <= maxPostgresBigInt, {
    message: "must fit in a PostgreSQL BIGINT",
  });

export const uploadInitiateRequestSchema = z
  .object({
    key: objectKeySchema,
    sizeBytes: sizeBytesSchema,
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "contentType contains control characters")
      .optional(),
    checksum: z.string().trim().min(1).max(255).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    overwrite: z.boolean().default(false),
  })
  .strict();

export const uploadCompleteRequestSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(10_000),
            etag: z.string().trim().min(1).max(255),
            sizeBytes: sizeBytesSchema,
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
  })
  .strict();

export type UploadInitiateRequest = z.infer<typeof uploadInitiateRequestSchema>;
export type UploadCompleteRequest = z.infer<typeof uploadCompleteRequestSchema>;
