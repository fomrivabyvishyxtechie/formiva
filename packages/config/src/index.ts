import { z } from 'zod';

// A bucket name only (3-63 lowercase letters, digits, hyphens). A pasted address crashed uploads in Test 3.
const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'must be the bucket name only, not a web address');

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // HMAC key for hashing respondent IPs into consent evidence. Unset = IPs are not recorded.
  IP_HASH_SECRET: z.string().min(32).optional(),
  // Cloudflare R2 (S3-compatible). Unset = upload-requests answers 503. Never log these.
  R2_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'must be the 32-character account id, not a web address')
    .optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_QUARANTINE_BUCKET: bucketName.optional(),
  R2_DOCUMENTS_BUCKET: bucketName.optional(),
  // ClamAV daemon (clamd) for the scanner worker.
  CLAMD_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),
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
