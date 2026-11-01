import type { FastifyInstance } from 'fastify';
import {
  DOC_SUBTYPES,
  documentPolicyBodySchema,
  documentPolicyListSchema,
  type DocSubtype,
} from '@formiva/contracts';

function routeError(statusCode: number, publicMessage: string) {
  return Object.assign(new Error(publicMessage), { statusCode, publicMessage });
}

interface PolicyRow {
  doc_subtype: string;
  collect_mode: string;
  require_masked: boolean;
  store_file: boolean;
  retain_days: number | null;
  purpose: string;
}

/**
 * Government Documents Policy admin API (ADR-14). Lists the document types a form may ask for
 * and lets a workspace owner/admin decide which it collects, and why. A type with no row is
 * "not collected" (fail closed). Caste, community and police documents are not in the catalog
 * served here, so they cannot be switched on through this API (ADR-27).
 */
export async function registerDocumentPolicyRoutes(app: FastifyInstance) {
  app.get(
    '/v1/document-policies',
    {
      config: {
        security: {
          authKind: 'jwt',
          permissions: ['case.read'],
          tenantScope: 'workspace',
          pathParams: [],
        },
      },
    },
    async (request, reply) => {
      const withTenant = request.withTenant;
      if (!withTenant) throw routeError(401, 'Authentication is required.');
      const rows = await withTenant({ permissions: ['case.read'] }, async (client) => {
        const r = await client.query<PolicyRow>(
          `SELECT doc_subtype, collect_mode, require_masked, store_file, retain_days, purpose
             FROM document_type_policies`,
        );
        return new Map(r.rows.map((p) => [p.doc_subtype, p]));
      });
      const items = (Object.keys(DOC_SUBTYPES) as DocSubtype[]).map((key) => {
        const meta = DOC_SUBTYPES[key];
        const p = rows.get(key);
        return {
          doc_subtype: key,
          doc_class: meta.doc_class,
          government_issued: meta.government_issued,
          collect_mode: p?.collect_mode ?? 'not_collected',
          require_masked: p?.require_masked ?? false,
          store_file: p?.store_file ?? true,
          retain_days: p?.retain_days ?? null,
          purpose: p?.purpose ?? '',
          configured: p !== undefined,
        };
      });
      reply.header('cache-control', 'no-store');
      return documentPolicyListSchema.parse({ items });
    },
  );

  app.put(
    '/v1/document-policies/:doc_subtype',
    {
      config: {
        security: {
          authKind: 'jwt',
          permissions: ['workspace.manage'],
          tenantScope: 'workspace',
          pathParams: ['doc_subtype'],
        },
      },
      bodyLimit: 4 * 1024,
    },
    async (request, reply) => {
      const withTenant = request.withTenant;
      if (!withTenant) throw routeError(401, 'Authentication is required.');
      const { doc_subtype } = request.params as { doc_subtype: string };

      // Authorization runs first (inside withTenant); only then is the body looked at.
      const saved = await withTenant(
        { permissions: ['workspace.manage'] },
        async (client, context) => {
          if (!Object.hasOwn(DOC_SUBTYPES, doc_subtype))
            throw routeError(404, 'Unknown document type.');
          const parsed = documentPolicyBodySchema.safeParse(request.body ?? {});
          if (!parsed.success) {
            throw routeError(422, parsed.error.issues[0]?.message ?? 'Document policy is invalid.');
          }
          const b = parsed.data;
          if (
            doc_subtype === 'aadhaar' &&
            b.collect_mode !== 'not_collected' &&
            !b.require_masked
          ) {
            throw routeError(422, 'Aadhaar can only be collected as a masked copy.');
          }
          const r = await client.query<{ id: string }>(
            `INSERT INTO document_type_policies
             (workspace_id, doc_subtype, collect_mode, require_masked, store_file, retain_days, purpose)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (workspace_id, doc_subtype) DO UPDATE
             SET collect_mode = EXCLUDED.collect_mode, require_masked = EXCLUDED.require_masked,
                 store_file = EXCLUDED.store_file, retain_days = EXCLUDED.retain_days,
                 purpose = EXCLUDED.purpose
           RETURNING id`,
            [
              context.workspaceId,
              doc_subtype,
              b.collect_mode,
              b.require_masked,
              b.store_file,
              b.retain_days,
              b.purpose,
            ],
          );
          const id = r.rows[0]!.id;
          await client.query(
            `SELECT app.audit('document_policy.updated', 'document_type_policy', $1, NULL, $2::jsonb, 'user', $3, NULL)`,
            [
              id,
              JSON.stringify({
                doc_subtype,
                collect_mode: b.collect_mode,
                require_masked: b.require_masked,
                store_file: b.store_file,
                retain_days: b.retain_days,
              }),
              context.userId,
            ],
          );
          return { doc_subtype, ...b };
        },
      );
      reply.header('cache-control', 'no-store');
      return saved;
    },
  );
}
