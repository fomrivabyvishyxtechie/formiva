import { z } from 'zod';

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
