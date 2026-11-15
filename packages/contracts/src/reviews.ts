import { z } from 'zod';

const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(1000);

export const reviewTaskParamsSchema = z.object({ task_id: uuid });
export const reviewTaskListQuerySchema = z.object({
  status: z.enum(['open', 'claimed', 'resolved', 'escalated']).optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  due_before: z.string().datetime().optional(),
  assignee: z.enum(['me']).optional(),
  reason: z.string().min(1).max(64).optional(),
  sensitivity: z
    .enum(['public', 'internal', 'confidential', 'sensitive', 'highly_sensitive'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const reviewClaimRequestSchema = z.object({
  row_version: z.number().int().min(1).optional(),
});
export const reviewCorrectRequestSchema = z.object({
  row_version: z.number().int().min(1),
  reason,
  corrections: z
    .array(z.object({ field: z.string().min(1).max(100), value: z.string().min(1).max(2000) }))
    .min(1)
    .max(20),
});
// 'rework' (return to the respondent) is not built yet, so it is not accepted.
export const reviewResolveRequestSchema = z.object({
  row_version: z.number().int().min(1).optional(),
  resolution: z.enum(['approved', 'corrected', 'quarantined', 'escalated']),
  reason: reason.optional(),
});

export const caseValuesParamsSchema = z.object({ case_id: uuid });
export const caseRevealParamsSchema = z.object({
  case_id: uuid,
  field_key: z.string().min(1).max(100),
});
export const caseRevealRequestSchema = z.object({ reason });

export const approvalRoundRequestSchema = z.object({
  workflow_step_key: z.string().trim().min(1).max(100),
  approver_user_ids: z.array(uuid).min(1).max(10),
});
export const approvalParamsSchema = z.object({ approval_id: uuid });
export const approvalDecideRequestSchema = z.object({
  decision: z.enum(['approve', 'reject', 'rework']),
  reason: reason.optional(),
});
export const approvalDelegateRequestSchema = z.object({ delegate_user_id: uuid, reason });
export const approvalListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
