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
  role: z.string().min(1),
  status: z.enum(['invited', 'active', 'suspended', 'left']),
});

export const workspaceMemberListResponseSchema = z.array(memberSchema);

export const workspaceMembersParamsSchema = z.object({
  workspace_id: z.string().uuid(),
});

export const workspaceMemberParamsSchema = workspaceMembersParamsSchema.extend({
  member_id: z.string().uuid(),
});

export const memberInviteRequestSchema = z.object({
  email: z.string().email(),
  role: z.string().trim().min(1).max(40),
});

export const memberRoleChangeRequestSchema = z.object({
  role: z.string().trim().min(1).max(40),
});
