# ADR-19 — Workspace bootstrap and invitation lifecycle

- **Date:** 2026-10-06
- **Owner decision:** Approved
- **Implementation status:** Implemented; Phase 2 acceptance remains blocked pending human security and technical reviewer approval
- **Scope:** Phase 2.3 workspace creation and member invitations only

## Context

`POST /v1/workspaces` currently requires workspace membership before its handler can run. It then attempts to create a second workspace in the selected tenant transaction, while `workspace_self` RLS only permits writes to the current workspace. The existing `app.bootstrap_workspace` also requires the workspace being bootstrapped to already be the transaction context. Workspace creation therefore has no safe bootstrap path for a new creator.

`workspace_members.status` includes `invited`, but the schema has no durable invitation record, secret hash, expiry, revocation, acceptance, or consume-once state. The current user projection stores an email but does not record whether it is verified. The current authentication identity exposes the verified JWT subject, not an approved verified-email claim.

The approved API contract forbids caller-supplied owner user IDs. The roadmap requires tenant isolation, audited changes, tests, and technical reviewer sign-off. The current project owner approves the designs below, but implementation remains gated on security and technical reviewer approval.

## Decisions

### Workspace bootstrap: restricted database-owned operation

Workspace creation will use a database-owned bootstrap capability and an explicit `Idempotency-Key`.

- Only the exact authenticated `POST /v1/workspaces` operation may bypass the ordinary pre-existing-membership lookup. JWT verification remains mandatory. All other `/v1` protected routes retain membership authorization.
- The API supplies the verified JWT subject, validated workspace fields, and idempotency key. It must not supply an owner user ID or authoritative workspace ID.
- The database operation resolves the active user projection from the verified subject, generates the workspace ID, and performs workspace creation, default role/permission setup, owner membership creation, `audit_event` (`workspace.bootstrapped`), and idempotency-result persistence atomically.
- Idempotency is scoped to the authenticated subject. Persist only a key fingerprint and canonical request fingerprint, protected by a uniqueness constraint and transaction-level serialization. A retry with the same key and request returns the original safe result; the same key with different input returns a safe conflict.
- The bootstrap capability (`app.bootstrap_workspace`) is owned by a new dedicated `formiva_bootstrap_definer` role, never by `formiva_definer`, the queue worker definer, or any other broad capability owner. It is `NOLOGIN`, `NOINHERIT`, and `BYPASSRLS`; `BYPASSRLS` is required solely because forced RLS prevents a pre-membership transaction from creating its first tenant row. The role owns only this bootstrap function and has no membership in runtime roles.
- `formiva_bootstrap_definer` receives exactly `USAGE` on `app` and `public`; `SELECT` on `users` and `permissions`; `INSERT` on `workspaces`, `roles`, `role_permissions`, `workspace_members`, `document_type_policies`, the new bootstrap-idempotency table, and `audit_events`; and no `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, role-membership, or default privilege grants. It has no privileges on queue, case, document (other than the required policy seed), workflow, integration, billing, or token-resolution tables and owns no unrelated function. The bootstrap function is `SECURITY DEFINER`, fixes `search_path` to `pg_catalog, app`, accepts only the verified subject, validated name/slug, and idempotency values, and cannot select a caller-controlled tenant or owner.
- `PUBLIC EXECUTE` is revoked for `app.bootstrap_workspace`; only `formiva_app` receives `EXECUTE`. No new direct DML grant is introduced for `formiva_app`; its existing RLS-governed runtime grants do not confer `BYPASSRLS` or ownership. It receives no execute grant on any unrelated privileged function. The migration must prove this with app-role direct-SQL tests, function-owner/grant catalog assertions, and attempted calls to every unrelated `SECURITY DEFINER` function.
- The migration creates the dedicated role and capability after identity-projection support and before the API route is enabled. Rollback first revokes `formiva_app` execute, disables the route in the release that introduced it, then drops the function, its idempotency objects, and the dedicated role only after confirming there are no live bootstrap transactions or retained idempotency records needed for replay. Operational revocation immediately revokes `EXECUTE` from `formiva_app`, terminates no transactions, and preserves audit evidence; restoration requires a reviewed migration or break-glass procedure. Monitor `pg_proc` ownership, function grants, role attributes, bootstrap failures, and every `workspace.bootstrapped` audit event for privilege drift.
- The bootstrap operation appends the bootstrap audit event in the same transaction. Any failure rolls back all workspace, role, membership, audit, and idempotency writes.
- No implementation may accept caller-selected owner identity, use an arbitrary workspace selector to authorize creation, or make general workspace RLS permissive.

### Verified-email identity projection: authoritative server-side synchronization

Invitation security will not trust optional email claims in an access token. The authoritative source is a Clerk server-to-server identity event or Clerk Backend API lookup whose authenticity is verified by the backend using Clerk's configured server-side verification mechanism. A JWT remains authoritative for the authenticated subject only. The current JWT verifier does not validate or project email claims and is therefore not sufficient by itself.

- A future additive migration adds `users.email_verified boolean not null default false`, `users.email_verified_at timestamptz`, `users.identity_synced_at timestamptz not null default now()`, and `users.identity_source_updated_at timestamptz`. It must retain the existing `email` column, add constraints/indexes needed for a normalized unique active identity projection, and leave applied migrations unchanged.
- The only synchronization path is a server-side identity synchronizer invoked from a signature-verified Clerk identity event and a server-to-server revalidation lookup. It resolves the subject internally, normalizes a non-empty email as `lower(trim(email))`, and writes the normalized email, verification state, source update time, and sync time in one transaction. Request bodies, headers, workspace selectors, and client-side claims may never supply `email` or `email_verified` to this operation.
- The synchronizer locks the projection row with `FOR UPDATE` (or uses an equivalent subject-keyed upsert with row locking). It rejects stale source events using the authoritative source update time. An email change atomically replaces the normalized projection email and sets `email_verified` only to the source's current verified state. Missing email, false verification, a verification revocation, an unparseable source timestamp, an unavailable authoritative lookup, or a stale/ambiguous event result in `email_verified = false` or no state advancement; invitation create and accept then fail closed without exposing identity or tenant details.
- Invitation create and accept re-read the locked active projection inside their transaction and require `email_verified = true`, a non-stale sync under the deployment's configured revalidation interval, and a normalized email match. They do not rely on a prior request's cached identity. Existing authenticated routes that do not need invitations remain unaffected by verification state.
- Identity synchronization audit and telemetry contain only subject-correlated opaque identifiers, outcome, source version/time, and failure class. They never contain raw email, verification values tied to an email, token, token hash, headers, or provider payloads. Monitoring alerts on sync failures, stale projections, email changes, verification revocations, rejected stale events, and invitation failures caused by unverified identity.
- Migration rollout first adds fail-closed fields and the restricted synchronizer, backfills only from verified server-side source reads, verifies row counts and false-default behavior, then enables invitation routes. Rollback disables invitation create/accept before removing the synchronizer; projection fields and audit evidence are retained until a separately reviewed retention migration. Recovery replays verified source events or performs a server-to-server revalidation, never accepts a client-provided email.

### Invitations: hashed bearer token bound to verified email

Invitations will use an opaque high-entropy bearer token whose raw value is never persisted.

- Invitation creation requires a verified JWT, active membership in the selected workspace, and `member.manage`; the workspace path must match the authorized tenant. The invitation stores the target workspace, an existing role belonging to that workspace, normalized recipient email (lowercase, trimmed), SHA-256 token hash, expiry, creator, and lifecycle timestamps.
- **Project Security Policy**: The approved expiry is **72 hours** from creation. Expired, revoked, unknown, or consumed invitations are unusable and must not reveal whether a token or workspace exists.
- The raw token is generated using a cryptographically secure random source (at least 256 bits/32 bytes), returned at most once, and never written to the database, audit payload, logs, URLs, traces, or error messages. External email delivery is deferred. For synthetic development only, the token may be included in the trusted backend response; production must fail closed rather than return a bearer token until delivery is separately approved.
- An owner/admin may create invitations under `member.manage`. Role assignment follows the existing owner boundary: admins may not grant the owner role; an owner may select a role already defined in that workspace. Invitation records cannot carry caller-selected workspace or role at acceptance time.
- Revocation (`DELETE /v1/invitations/:invitation_id`) is authorized by active workspace membership and `member.manage`, with path/tenant match, and records an immutable audit event. Creation and revocation events contain safe metadata only, never the token or token hash.
- Acceptance (`POST /v1/invitations/accept`) requires a valid JWT but no existing workspace membership. It is the only invitation-acceptance route allowed through the pre-membership auth path. The route accepts the token only; workspace and role are resolved exclusively from the invitation row.
- The authenticated subject is resolved to the server-side verified-email projection defined above. Synchronization MUST fail closed when the authoritative source is missing, false, revoked, stale, or unavailable. Acceptance requires the locked, trusted `email_verified` attribute and normalized email to match the invitation recipient. A request-supplied email or an unvalidated access-token email claim is never sufficient.
- In one transaction, acceptance locks the invitation row, checks token hash, expiry, revocation, unused status, verified email, and workspace/role consistency; creates or activates exactly one membership; marks the invitation consumed; and appends an audit event. Concurrent acceptance and every replay fail safely after the first successful consume.
- Invitation creation should use an idempotency key so retried creates do not mint multiple live invitations for the same operation. The exact replay response must not reveal a previously returned raw token; clients must not assume the secret can be retrieved again.
- Monitoring and logging must filter sensitive data, including `token`, `token_hash`, and `email`.

## Proposed schema and API work

All schema work is additive in a new migration; applied migrations must remain unchanged. Rollback logic for migrations is defined as `DROP` operations.

- Add an invitation table with workspace-scoped role constraints, normalized recipient, unique token hash, expiry, revocation/consumption state, actor references, and tenant RLS. Add uniqueness/locking support for invitation idempotency and any constraints required to prevent duplicate or conflicting membership activation.
- Add the explicit verified-email projection fields and restricted server-side synchronization path before relying on it.
- Use a narrowly granted database-owned workspace bootstrap function (`app.bootstrap_workspace`) owned only by `formiva_bootstrap_definer` and its idempotency storage.
- Keep `POST /v1/workspaces` as the contract operation, adding required `Idempotency-Key` semantics.
- Add invitation-creation path `POST /v1/workspaces/{workspace_id}/members/invitations`, invitation-revocation `DELETE /v1/invitations/:invitation_id`, and JWT-authenticated acceptance `POST /v1/invitations/accept` with body `{"token": "..."}`.
- Do not add email delivery, external providers, or provider-specific terms in this decision.

## Assumptions and threats

The verified JWT subject is trustworthy after current JWT verification. Verified-email state is trustworthy only after the planned signature-verified Clerk server-to-server synchronization and projection controls are implemented and tested; the current access-token verifier is not an email-verification authority.

Threats include pre-membership auth bypass expansion, cross-tenant bootstrap, privilege escalation by assigning owner/admin roles, idempotency races, token theft or brute force, email mismatch, invitation replay, concurrent acceptance, token leakage through logs/traces, and audit disclosure. The controls above require narrow route exceptions, database-owned identity/tenant resolution, restricted database capability, 72-hour expiry, hashed secrets, email binding, row locking/one-time consumption, role boundaries, safe errors, and atomic hash-chained audit events.

## Required validation before implementation can begin

Security and technical reviewers must approve this ADR, including the privileged database capability and identity-projection trust path. Record reviewer names, dates, and explicit approval here before implementation. No source, migration, contract, fixture, or deployment changes for these designs are authorized until that approval is recorded. The project owner's approval establishes the technical direction. Implementation is authorized only when the security and technical reviewers both explicitly return PASS.

**Implementation status note (2026-10-09):** The project owner explicitly requested completion of the existing partial implementation. The work has proceeded under that request, but no human security or technical reviewer approval is recorded here. This does not satisfy the review gate or authorize Phase 2 acceptance/deployment; obtain and record both approvals before declaring Phase 2 complete.

## AI-generated Codex independent review — 2026-10-08

- **Security reviewer:** Codex — independent security review (AI-generated; not human sign-off)
- **Technical reviewer:** Codex — independent technical review (AI-generated; not human sign-off)
- **Review date:** 2026-10-08
- **Security review:** PASS — the revised design resolves the prior High findings; implementation remains gated on future migration and test evidence.
- **Technical review:** PASS — the design is implementable through additive migrations using the observed role, RLS, and identity-projection model.
- **Critical findings:** None
- **High findings:** None.

### High findings

1. **[RESOLVED] Verified-email trust path.** The ADR now identifies a signature-verified Clerk server-to-server event or Backend API lookup as the source, separates it from current JWT-subject verification, defines additive projection fields, row-locking and stale-event behavior, fail-closed handling, redaction, rollout, recovery, monitoring, and required transaction-time revalidation.
2. **[RESOLVED] Bootstrap capability separation.** The ADR now requires a new `NOLOGIN`, `NOINHERIT`, dedicated `BYPASSRLS` owner with only bootstrap-object privileges, a fixed search path, revoked `PUBLIC EXECUTE`, a single `formiva_app` execute grant, privilege-drift monitoring, and direct app-role abuse tests.

### Authorization outcome

This is an AI-generated review, not human reviewer sign-off. It does not satisfy any project policy requiring human approval. The former design findings are resolved. Human review, implementation evidence, and the Phase 2 exit criteria remain required before acceptance or deployment.

### Implementation evidence (2026-10-09)

- Added additive identity/bootstrap/invitation migrations through migration 014; migrations 001–009 remain unchanged.
- The API uses the Clerk Backend API for trusted identity projection, performs workspace bootstrap and invitation acceptance through restricted database capabilities, and registers the invitation routes.
- Bootstrap and invitation creation are idempotent; invitation acceptance is one-time, locks the invitation row, does not alter an already-active membership, and records consumption/audit in the same transaction.
- API contracts now specify the strict pre-membership requests and safe response shapes. Invitation responses omit recipient email; sensitive-data redaction covers email values.
- Full requested validation passed on the disposable PostgreSQL 16 test database: format, lint, typecheck, API build, DB (105 checks), API (8 files/39 tests), tenant isolation (12 tests), `pnpm run verify`, and `git diff --check`.
- Human security/technical reviewer approvals remain outstanding; Phase 2 is not accepted, and Phase 3 remains blocked.

Reviewers should inspect the recorded evidence and the implementation tests for:

- Bootstrap: missing/invalid JWT, unknown or inactive identity, caller-supplied owner/workspace rejection, slug conflict, same-key replay, changed-body conflict, concurrent retries, role/membership/audit atomicity, rollback, and app-role/RLS isolation.
- Invitations: owner/admin authorization and role limits, token entropy and hash-only persistence, no token in logs/audit, synthetic-only token response guard, 72-hour expiry, revocation, verified-email mismatch, foreign/unknown safe errors, tenant/workspace spoof attempts, concurrent acceptance, one-time consume, replay, idempotent creation, and atomic membership plus audit.
- Regression: existing tenant-isolation and protected-route inventory tests, including explicit coverage for every new route and the exact auth exceptions.

## Governing sources

1. Current migrations, API/auth implementation, and tests establish the observed failure and available behavior.
2. The approved API contract governs route intent and prohibits client-supplied owner IDs.
3. The roadmap Phase 2 Prompt 2.3 and Phase 2 exit test govern scope and require reviewer sign-off.
4. The Review & Change Register preserves workspace isolation and immutable audit requirements.
5. ADR-17 and ADR-18 do not alter workspace bootstrap or invitation behavior.

Where this ADR adds design detail not present in those sources, it is an owner-approved proposal only until the required reviewers approve it.

## Consequences

- Phase 2 remains incomplete until reviewer approval, implementation, tests, and the Phase 2 exit gate pass.
- Phase 3 remains blocked and must not begin.
- External invitation delivery remains out of scope.
- The current invitation token response is permitted only in explicitly synthetic development; production token delivery is unresolved and requires a separately approved channel.
