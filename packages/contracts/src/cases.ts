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

export const caseSchema = z.object({
  id: z.string().uuid(),
  case_number: z.string().regex(/^[1-9]\d*$/),
  status: caseStatusSchema,
  created_at: z.string().datetime(),
});

export const caseTimelineParamsSchema = z.object({
  case_id: z.string().uuid(),
});

export const caseTimelineResponseSchema = z.object({
  items: z.array(
    z.object({
      occurred_at: z.string().datetime(),
      correlation_id: z.string().uuid(),
      event: z.literal('case_activity'),
    }),
  ),
});

export const caseReworkParamsSchema = z.object({
  case_id: z.string().uuid(),
});

export const caseReworkRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .refine(
        (reason) =>
          ![...reason].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
          }),
      )
      .refine(
        (reason) => !/\b\d{8,}\b|\b\d{4}(?:[ -]\d{4})+\b|\b[A-Z]{5}\d{4}[A-Z]\b/i.test(reason),
      ),
  })
  .strict();

export const caseReworkResponseSchema = z.object({
  case_id: z.string().uuid(),
  status: z.literal('review_queued'),
  correlation_id: z.string().uuid(),
});

export const caseReworkIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/);

export const caseListResponseSchema = z.object({
  items: z.array(caseSchema),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

export type CaseListQuery = z.infer<typeof caseListQuerySchema>;
export type CaseListResponse = z.infer<typeof caseListResponseSchema>;
