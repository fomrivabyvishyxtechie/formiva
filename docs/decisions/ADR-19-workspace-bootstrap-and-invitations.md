# ADR-19 — Workspace bootstrap and invitation lifecycle

- **Date:** 2026-10-06
- **Owner decision:** Approved
- **Implementation status:** Blocked pending security and technical reviewer approval
- **Scope:** Phase 2.3 workspace creation and member invitations only

## Context

`POST /v1/workspaces` currently requires workspace membership before its handler can run. It then attempts to create a second workspace in the selected tenant transaction, while `workspace_self` RLS only permits writes to the current workspace. The existing `app.bootstrap_workspace` also requires the workspace being bootstrapped to already be the transaction context. Workspace creation therefore has no safe bootstrap path for a new creator.

`workspace_members.status` includes `invited`, but the schema has no durable invitation record, secret hash, expiry, revocation, acceptance, or consume-once state. The current user projection stores an email but does not record whether it is verified. The current authentication identity exposes the verified JWT subject, not an approved verified-email claim.

The approved API contract forbids caller-supplied owner user IDs. The roadmap requires tenant isolation, audited changes, tests, and technical reviewer sign-off. The current project owner approves the designs below, but implementation remains gated on security and technical reviewer approval.

## Decisions

### Workspace bootstrap: restricted database-owned operation

Workspace creation will use a database-owned bootstrap capability and an explicit `Idempotency-Key`.

- Only the exact authenticated `POST /v1/workspaces` operation may bypass the ordinary pre-existing-membership lookup. JWT verification remains mandatory. Other `/v1` operations retain current membership authorization.
- The API supplies the verified JWT subject, validated workspace fields, and idempotency key. It must not supply an owner user ID or authoritative workspace ID.
- The database operation resolves the active user projection from the verified subject, generates the workspace ID, and performs workspace creation, default role/permission setup, owner membership creation, audit append, and idempotency-result persistence atomically.
- Idempotency is scoped to the authenticated subject. Persist only a key fingerprint and canonical request fingerprint, protected by a uniqueness constraint and transaction-level serialization. A retry with the same key and request returns the original safe result; the same key with different input returns a safe conflict.
- The bootstrap capability must be narrowly executable, use a fixed search path, validate the resolved active identity, and avoid granting the application a general RLS bypass. Any privileged function owner must be a dedicated non-login principal with only the grants required for this operation; do not reuse the queue definer role.
- The database operation appends the bootstrap audit event in the same transaction. Any failure rolls back all workspace, role, membership, audit, and idempotency writes.
- No implementation may accept caller-selected owner identity, use an arbitrary workspace selector to authorize creation, or make general workspace RLS permissive.

### Invitations: hashed bearer token bound to verified email

Invitations will use an opaque high-entropy bearer token whose raw value is never persisted.

- Invitation creation requires a verified JWT, active membership in the selected workspace, and `member.manage`; the workspace path must match the authorized tenant. The invitation stores the target workspace, an existing role belonging to that workspace, normalized recipient email, SHA-256 token hash, expiry, creator, and lifecycle timestamps.
- The approved expiry is **72 hours** from creation. Expired, revoked, unknown, or consumed invitations are unusable and must not reveal whether a token or workspace exists.
- The raw token is generated using a cryptographically secure random source, returned at most once, and never written to the database, audit payload, logs, URLs, traces, or error messages. External email delivery is deferred. For synthetic development only, the token may be included in the trusted backend response; production must fail closed rather than return a bearer token until delivery is separately approved.
- An owner/admin may create invitations under `member.manage`. Role assignment follows the existing owner boundary: admins may not grant the owner role; an owner may select a role already defined in that workspace. Invitation records cannot carry caller-selected workspace or role at acceptance time.
- Revocation is authorized by active workspace membership and `member.manage`, with path/tenant match, and records an immutable audit event. Creation and revocation events contain safe metadata only, never the token or token hash.
- Acceptance requires a valid JWT but no existing workspace membership. It is the only invitation-acceptance route allowed through the pre-membership auth path. The route accepts the token only; workspace and role are resolved exclusively from the invitation row.
- The authenticated subject is resolved to the server-side user projection. Acceptance requires an explicit, trusted `email_verified` attribute and an email normalized to match the invitation recipient. The current projection does not contain this attribute; an approved projection/synchronization path must set it from authoritative identity-provider verification data. A request-supplied email or an unverified email claim is never sufficient.
- In one transaction, acceptance locks the invitation row, checks token hash, expiry, revocation, unused status, verified email, and workspace/role consistency; creates or activates exactly one membership; marks the invitation consumed; and appends an audit event. Concurrent acceptance and every replay fail safely after the first successful consume.
- Invitation creation should use an idempotency key so retried creates do not mint multiple live invitations for the same operation. The exact replay response must not reveal a previously returned raw token; clients must not assume the secret can be retrieved again.

## Proposed schema and API work

All schema work is additive in a new migration; applied migrations must remain unchanged.

- Add an invitation table with workspace-scoped role constraints, normalized recipient, unique token hash, expiry, revocation/consumption state, actor references, and tenant RLS. Add uniqueness/locking support for invitation idempotency and any constraints required to prevent duplicate or conflicting membership activation.
- Add the explicit verified-email attribute to the server-side identity projection and define the trusted synchronization/update path before relying on it.
- Add a narrowly granted database-owned workspace bootstrap function and its idempotency storage. Do not reuse `app.bootstrap_workspace` as a cross-tenant bypass without reviewing its execution privileges and context semantics.
- Keep `POST /v1/workspaces` as the contract operation, adding required `Idempotency-Key` semantics.
- Keep the contracted invitation-creation path `POST /v1/workspaces/{workspace_id}/members/invitations`; define safe response behavior and the synthetic-development-only token response.
- Add a tenant-scoped invitation-revocation operation and a JWT-authenticated acceptance operation that resolves tenancy only from the hashed-token record. Exact paths and response schemas must be added to the API contract after reviewer approval.
- Do not add email delivery, external providers, or provider-specific terms in this decision.

## Assumptions and threats

The verified JWT subject is trustworthy after current JWT verification, and a server-side identity projection can be updated from an authoritative verified-email signal. That signal and its update mechanism do not yet exist in the current code and must be reviewed before implementation.

Threats include pre-membership auth bypass expansion, cross-tenant bootstrap, privilege escalation by assigning owner/admin roles, idempotency races, token theft or brute force, email mismatch, invitation replay, concurrent acceptance, token leakage through logs/traces, and audit disclosure. The controls above require narrow route exceptions, database-owned identity/tenant resolution, restricted database capability, 72-hour expiry, hashed secrets, email binding, row locking/one-time consumption, role boundaries, safe errors, and atomic hash-chained audit events.

## Required validation before implementation can begin

Security and technical reviewers must approve this ADR, including the privileged database capability and identity-projection trust path. Record reviewer names, dates, and explicit approval here before implementation. No source, migration, contract, fixture, or deployment changes for these designs are authorized until that approval is recorded.

After approval, implementation tests must cover:

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
