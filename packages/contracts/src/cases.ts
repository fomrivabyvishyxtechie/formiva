import { z } from 'zod';

export const caseStatusSchema = z.enum([
  'draft',
  'submitted',
  'intake_validated',
  'ai_processing',
  'review_queued',
  'review_in_progress',
  'workflow_ready',
  'approval_pending',
  'action_executing',
  'action_blocked',
  'completed',
  'confirmed',
  'closed',
  'rejected',
  'quarantined',
  'cancelled',
]);

export const caseListQuerySchema = z.object({
  status: caseStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const caseListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      case_number: z.string().regex(/^[1-9]\d*$/),
      status: caseStatusSchema,
      created_at: z.string().datetime(),
    }),
  ),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

export type CaseListQuery = z.infer<typeof caseListQuerySchema>;
export type CaseListResponse = z.infer<typeof caseListResponseSchema>;
