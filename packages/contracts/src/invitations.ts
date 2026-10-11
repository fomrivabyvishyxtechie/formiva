import { z } from 'zod';

export const invitationRequestSchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: z.string().trim().min(1).max(40),
  })
  .strict();

export const invitationAcceptRequestSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export const invitationResponseSchema = z.object({
  id: z.string().uuid(),
  expires_at: z.string().datetime(),
  token: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const invitationAcceptResponseSchema = z.object({
  workspace_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.string(),
});

export const invitationParamsSchema = z.object({
  workspace_id: z.string().uuid(),
});

export const invitationDeleteParamsSchema = z.object({
  invitation_id: z.string().uuid(),
});
