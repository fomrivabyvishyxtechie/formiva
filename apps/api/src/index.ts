import Fastify from 'fastify';
import { Pool } from 'pg';

import { loadConfig } from '@formiva/config';
import { createProblemDetails } from '@formiva/contracts';
import {
  generateCorrelationId,
  getOrCreateCorrelationId,
  getOrCreateRequestId,
  safeSerializeError,
} from '@formiva/observability';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerInvitationRoutes } from './routes/invitations.js';
import { registerPublicRoutes } from './routes/public.js';
import { createS3ObjectStore, type UploadSigner } from './services/object-store.js';
import { logSerializers, redactUrl } from './log-redaction.js';
import authPlugin, { type AuthPluginOptions } from './auth.js';
import type { RouteSecurity } from './security-metadata.js';

export async function buildApp(
  env: Record<string, string | undefined> = process.env,
  dependencies: {
    pool?: Pool;
    objectStore?: UploadSigner;
    auth?: Pick<AuthPluginOptions, 'jwksFetch' | 'testMode' | 'identityLookup'>;
  } = {},
) {
  const rawEnvironment = { ...process.env, ...env };
  const config = loadConfig(rawEnvironment);
  const testMode = rawEnvironment.NODE_ENV === 'test' && dependencies.auth?.testMode === true;
  const authorizedParties = rawEnvironment.CLERK_AUTHORIZED_PARTIES?.split(',')
    .map((party) => party.trim())
    .filter(Boolean);
  const missingClerkConfiguration = [
    !rawEnvironment.CLERK_ISSUER && 'CLERK_ISSUER',
    !rawEnvironment.CLERK_AUDIENCE && 'CLERK_AUDIENCE',
    !rawEnvironment.CLERK_JWKS_URL && 'CLERK_JWKS_URL',
    !authorizedParties?.length && 'CLERK_AUTHORIZED_PARTIES',
    !rawEnvironment.CLERK_SECRET_KEY && 'CLERK_SECRET_KEY',
  ].filter((name): name is string => Boolean(name));

  if (rawEnvironment.NODE_ENV !== 'test' && missingClerkConfiguration.length > 0) {
    throw new Error(`Missing Clerk configuration: ${missingClerkConfiguration.join(', ')}`);
  }

  const app = Fastify({
    logger: config.NODE_ENV !== 'test' ? { serializers: logSerializers } : false,
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  });

  // Fail closed at startup: a route without security metadata never gets registered.
  // Must be added before any route module so it sees every route.
  const routeSecurity = new Map<string, RouteSecurity>();
  app.decorate('routeSecurity', routeSecurity);
  app.addHook('onRoute', (routeOptions) => {
    const security = routeOptions.config?.security;
    const methods = [routeOptions.method].flat();
    if (!security) {
      throw new Error(`Route ${methods.join(',')} ${routeOptions.url} lacks security metadata.`);
    }
    for (const method of methods) routeSecurity.set(`${method} ${routeOptions.url}`, security);
  });

  app.register(authPlugin, {
    pool: dependencies.pool,
    issuer: rawEnvironment.CLERK_ISSUER,
    audience: rawEnvironment.CLERK_AUDIENCE,
    jwksUrl: rawEnvironment.CLERK_JWKS_URL,
    authorizedParties,
    jwksFetch: dependencies.auth?.jwksFetch,
    testMode,
    identityLookup: dependencies.auth?.identityLookup,
  });

  if (dependencies.pool) {
    await registerWorkspaceRoutes(app, dependencies.pool);
    await registerCaseRoutes(app);
    await registerInvitationRoutes(app, dependencies.pool);
    const objectStore =
      dependencies.objectStore ??
      (config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY
        ? createS3ObjectStore({
            accountId: config.R2_ACCOUNT_ID,
            accessKeyId: config.R2_ACCESS_KEY_ID,
            secretAccessKey: config.R2_SECRET_ACCESS_KEY,
          })
        : undefined);
    await registerPublicRoutes(app, dependencies.pool, {
      ipHashSecret: config.IP_HASH_SECRET,
      objectStore,
      quarantineBucket: config.R2_QUARANTINE_BUCKET,
    });
  }

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
    const fastifyError = error as Error & {
      statusCode?: number;
      publicMessage?: string;
      code?: string;
    };
    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
      request.id ?? generateCorrelationId(),
    );
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    const serialized = safeSerializeError(error);
    const titles: Record<number, string> = {
      400: 'Bad request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Resource not found',
      409: 'Conflict',
      422: 'Unprocessable request',
      429: 'Too many requests',
      501: 'Not implemented',
      503: 'Service unavailable',
    };
    const problemTypes: Record<number, string> = {
      400: 'bad-request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not-found',
      409: 'conflict',
      422: 'unprocessable',
      429: 'rate-limited',
      501: 'not-implemented',
      503: 'service-unavailable',
    };
    if (statusCode === 401) reply.header('www-authenticate', 'Bearer');

    const problem = createProblemDetails({
      type: `https://api.formiva.invalid/problems/${problemTypes[statusCode] ?? 'internal-error'}`,
      title: titles[statusCode] ?? 'Internal server error',
      status: statusCode,
      detail:
        statusCode === 500
          ? 'An unexpected error occurred.'
          : (fastifyError.publicMessage ?? String(serialized.message)),
      instance: redactUrl(request.raw.url),
      correlation_id: correlationId,
      errors: [
        {
          code: fastifyError.code ?? (statusCode === 404 ? 'not_found' : 'request_error'),
          message:
            statusCode === 500
              ? 'An unexpected error occurred.'
              : (fastifyError.publicMessage ?? String(serialized.message)),
        },
      ],
    });

    reply.code(statusCode).type('application/problem+json').send(problem);
  });

  app.get(
    '/healthz',
    {
      config: {
        security: { authKind: 'open', permissions: 'none', tenantScope: 'none', pathParams: [] },
      },
    },
    async (request, reply) => {
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
    },
  );

  return app;
}

export async function startServer() {
  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : undefined;
  const app = await buildApp(process.env, { pool });
  if (pool) app.addHook('onClose', () => pool.end());
  try {
    await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
  } catch (error) {
    if (pool) await pool.end();
    throw error;
  }
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('Failed to start API server', error);
    process.exitCode = 1;
  });
}
