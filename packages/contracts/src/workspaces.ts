import { z } from 'zod';

export const workspaceCreateRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
});

export const workspaceCreateResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export const memberSchema = z.object({
  user_id: z.string().uuid(),
  role: z.string(),
  status: z.string(),
});

export const workspaceMemberListResponseSchema = z.array(memberSchema);

export const memberInviteRequestSchema = z.object({
  email: z.string().email(),
  role: z.string(),
});

export const memberRoleChangeRequestSchema = z.object({
  role: z.string(),
});
