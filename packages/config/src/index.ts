import { z } from 'zod';

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // HMAC key for hashing respondent IPs into consent evidence. Unset = IPs are not recorded.
  IP_HASH_SECRET: z.string().min(32).optional(),
  // Cloudflare R2 (S3-compatible). Unset = upload-requests answers 503. Never log these.
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_QUARANTINE_BUCKET: z.string().min(1).optional(),
  API_NAME: z.string().min(1).default('formiva-api'),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function loadConfig(
  rawEnvironment: Record<string, string | undefined> = process.env,
): AppEnvironment {
  const parsed = environmentSchema.safeParse(rawEnvironment);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return parsed.data;
}
