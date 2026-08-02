import { z } from "zod";

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
});

export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

