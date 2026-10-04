import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type RemoteJWKSet,
} from 'jose';
import {
  withAuthorizedTenant,
  type TenantAuthorizationContext,
  type TenantAuthorizationRequirements,
} from '@formiva/db';

export interface AuthenticatedIdentity {
  subject: string;
}

export type RequestWithTenant = <T>(
  requirements: TenantAuthorizationRequirements,
  callback: (client: PoolClient, context: TenantAuthorizationContext) => Promise<T>,
) => Promise<T>;

export interface AuthPluginOptions {
  pool?: Pool;
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  authorizedParties?: readonly string[];
  jwksFetch?: FetchImplementation;
}

declare module 'fastify' {
  interface FastifyRequest {
    authIdentity: AuthenticatedIdentity | null;
    withTenant: RequestWithTenant | null;
  }
}

class AuthenticationError extends Error {
  constructor(
    public readonly statusCode: 400 | 401 | 503,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AuthenticationError';
  }
}

function isWorkspaceRoute(url: string | undefined): boolean {
  return url === '/v1' || url?.startsWith('/v1/') === true;
}

function getWorkspaceSelector(request: FastifyRequest): string | undefined {
  const value = request.headers['x-workspace-id'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new AuthenticationError(400, 'X-Workspace-Id must be a UUID.');
  }
  return value.toLowerCase();
}

function getToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    throw new AuthenticationError(401, 'Authentication is required.');
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  const token = match?.[1];
  if (!token || token.length > 8192) {
    throw new AuthenticationError(401, 'The bearer token is invalid.');
  }
  return token;
}

function createJwks(options: AuthPluginOptions): RemoteJWKSet | undefined {
  if (!options.jwksUrl) return undefined;
  try {
    const url = new URL(options.jwksUrl);
    if (url.protocol !== 'https:') return undefined;
    return createRemoteJWKSet(url, {
      ...(options.jwksFetch ? { [customFetch]: options.jwksFetch } : {}),
    });
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function isUnavailableJwksError(error: errors.JOSEError): boolean {
  return ['ERR_JWKS_INVALID', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'].includes(
    error.code,
  );
}

async function verifyRequest(
  request: FastifyRequest,
  options: AuthPluginOptions,
  jwks: RemoteJWKSet | undefined,
): Promise<AuthenticatedIdentity> {
  const token = getToken(request);
  const parties = options.authorizedParties?.filter(Boolean) ?? [];
  if (!options.issuer || !options.audience || parties.length === 0 || !jwks) {
    throw new AuthenticationError(503, 'Authentication is not configured.');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
      requiredClaims: ['sub', 'exp', 'azp'],
    }));
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      if (isUnavailableJwksError(error)) {
        throw new AuthenticationError(503, 'The identity provider is unavailable.');
      }
      throw new AuthenticationError(401, 'The bearer token is invalid.');
    }
    throw new AuthenticationError(503, 'The identity provider is unavailable.');
  }

  if (
    typeof payload.sub !== 'string' ||
    typeof payload.azp !== 'string' ||
    !parties.includes(payload.azp)
  ) {
    throw new AuthenticationError(401, 'The bearer token is invalid.');
  }

  return { subject: payload.sub };
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const jwks = createJwks(options);
  app.decorateRequest('authIdentity', null);
  app.decorateRequest('withTenant', null);

  app.addHook('preHandler', async (request) => {
    if (!isWorkspaceRoute(request.routeOptions.url)) return;

    const identity = await verifyRequest(request, options, jwks);
    request.authIdentity = identity;

    const workspaceSelector = getWorkspaceSelector(request);
    const pool = options.pool;
    if (!pool) throw new AuthenticationError(503, 'Workspace authorization is unavailable.');

    const withTenant: RequestWithTenant = (requirements, callback) =>
      withAuthorizedTenant(pool, identity.subject, workspaceSelector, requirements, callback);
    request.withTenant = withTenant;

    await withTenant({}, async () => undefined);
  });
};

export default fp(authPlugin, { name: 'formiva-auth' });
