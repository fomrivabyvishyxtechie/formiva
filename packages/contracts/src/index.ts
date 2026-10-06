import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok']);

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string().min(1),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
  uptimeMs: z.number().int().nonnegative(),
  environment: z.enum(['development', 'test', 'production']),
  requestId: z.string().optional(),
  correlationId: z.string().optional(),
});

export const problemErrorSchema = z.object({
  field: z.string().optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().min(1).optional(),
  instance: z.string().optional(),
  correlation_id: z.string().optional(),
  errors: z.array(problemErrorSchema).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ProblemError = z.infer<typeof problemErrorSchema>;

export function createProblemDetails(input: {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  correlation_id?: string;
  errors?: ProblemError[];
}): ProblemDetails {
  return {
    type: input.type,
    title: input.title,
    status: input.status,
    detail: input.detail ?? 'Request failed.',
    ...(input.instance ? { instance: input.instance } : {}),
    ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
    ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
  };
}

export {
  workspaceCreateRequestSchema,
  workspaceCreateResponseSchema,
  memberSchema,
  workspaceMemberListResponseSchema,
  workspaceMembersParamsSchema,
  workspaceMemberParamsSchema,
  memberInviteRequestSchema,
  memberRoleChangeRequestSchema,
} from './workspaces.js';
export {
  caseListQuerySchema,
  caseListResponseSchema,
  caseTimelineParamsSchema,
  caseTimelineResponseSchema,
  caseDocumentsParamsSchema,
  caseDocumentsResponseSchema,
  caseDocumentSchema,
  caseReworkParamsSchema,
  caseReworkRequestSchema,
  caseReworkResponseSchema,
  caseReworkIdempotencyKeySchema,
  caseCancelParamsSchema,
  caseCancelRequestSchema,
  caseCancelResponseSchema,
  caseStatusSchema,
  caseSchema,
} from './cases.js';
export type { CaseListQuery, CaseListResponse } from './cases.js';
