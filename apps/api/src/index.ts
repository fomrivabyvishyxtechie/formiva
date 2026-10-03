import Fastify from 'fastify';

import { loadConfig } from '@formiva/config';
import { createProblemDetails } from '@formiva/contracts';
import {
  generateCorrelationId,
  getOrCreateCorrelationId,
  getOrCreateRequestId,
  safeSerializeError,
} from '@formiva/observability';

export function buildApp(env: Record<string, string | undefined> = process.env) {
  const rawEnvironment = { ...process.env, ...env };
  const config = loadConfig(rawEnvironment);
  const app = Fastify({
    logger: config.NODE_ENV !== 'test',
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    const requestId = getOrCreateRequestId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );

    reply.header('x-request-id', requestId);
    reply.header('x-correlation-id', correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as Error & { statusCode?: number };
    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
      request.id ?? generateCorrelationId(),
    );
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    const serialized = safeSerializeError(error);

    const problem = createProblemDetails({
      type:
        statusCode === 404
          ? 'https://api.formiva.invalid/problems/not-found'
          : 'https://api.formiva.invalid/problems/internal-error',
      title: statusCode === 404 ? 'Resource not found' : 'Internal server error',
      status: statusCode,
      detail: statusCode === 500 ? 'An unexpected error occurred.' : String(serialized.message),
      instance: request.raw.url,
      correlation_id: correlationId,
      errors: [
        {
          code: statusCode === 404 ? 'not_found' : 'internal_error',
          message: String(serialized.message),
        },
      ],
    });

    reply.code(statusCode).type('application/problem+json').send(problem);
  });

  app.get('/healthz', async (request, reply) => {
    const requestId = getOrCreateRequestId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );

    const payload = {
      status: 'ok' as const,
      service: config.API_NAME,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000),
      environment: config.NODE_ENV,
      requestId,
      correlationId,
    };

    reply.header('x-request-id', requestId);
    reply.header('x-correlation-id', correlationId);

    return payload;
  });

  return app;
}

export async function startServer() {
  const app = buildApp();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('Failed to start API server', error);
    process.exitCode = 1;
  });
}
