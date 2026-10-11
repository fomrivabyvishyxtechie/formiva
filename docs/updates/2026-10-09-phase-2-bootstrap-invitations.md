# Update: Phase 2 Workspace Bootstrap and Invitations

## Date
2026-10-09

## Summary
Completed the Phase 2 workspace bootstrap and invitation lifecycle implementation, then ran the requested repository validation sequence successfully.

## Why
The prior implementation could not bootstrap a creator without membership, lacked a complete invitation lifecycle, and did not establish a trusted verified-email projection for invitation acceptance.

## Changed
- Replaced the invalid Clerk backend API import with `createClerkClient`, added server-side `CLERK_SECRET_KEY` validation, and added mocked Clerk lookup tests.
- Added trusted identity synchronization from Clerk Backend API data, normalized email storage, freshness/verification checks, and fail-closed behavior without reading JWT email claims.
- Implemented atomic pre-membership workspace bootstrap and invitation acceptance capabilities, plus invitation create/revoke routes and registration.
- Added additive migrations for identity projection, invitation lifecycle/RLS/idempotency, dedicated capabilities, replay checks, and safe active-member handling. Migrations 001–009 remain unchanged.
- Tightened request/response contracts, problem details, token validation, hash-only token persistence, and sensitive-data redaction.
- Extended API, PostgreSQL capability, and tenant-isolation coverage. Updated ADR-19, API contract, Phase 2 evidence, changelog, and engineering lessons.

## Tests/checks
All commands ran in one PowerShell process with:
`DATABASE_URL=postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test`

- `pnpm install` — passed; lockfile up to date.
- `pnpm run format:check` — passed.
- `pnpm run lint` — passed.
- `pnpm run typecheck` — passed.
- `pnpm --filter @formiva/api run build` — passed.
- `pnpm --filter @formiva/db run test` — passed, 105 assertion checks.
- `pnpm --filter @formiva/api run test` — passed, 8 files / 39 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts` — passed, 12 tests; route inventory covers 13 protected routes.
- `pnpm run verify` — passed.
- `git diff --check` — passed.

## Security
JWTs establish the subject only; verified email is sourced by server-side Clerk Backend API lookup and required to be fresh. Invitation tokens use 32 bytes of cryptographic randomness; only SHA-256 digests are persisted or passed to the acceptance capability. Recipient email, tokens, and token hashes are omitted from API responses (except the explicitly synthetic development token response), audit payloads, and telemetry. Bootstrap and acceptance run through narrowly granted database functions. Tests use mocks/synthetic identities and the designated local PostgreSQL database; no real Clerk credential was used.

## Migration/deployment
Apply the additive migrations through 014 before deploying the API. Production startup requires `CLERK_SECRET_KEY` and the existing Clerk issuer/audience/JWKS/authorized-party configuration. External invitation delivery and production token delivery remain out of scope. Do not deploy or declare Phase 2 accepted until the human security and technical reviewers approve ADR-19 and the Phase 2 exit evidence.

## Follow-up
Obtain and record human security and technical reviewer approvals. Phase 2 acceptance remains gated by those approvals; Phase 3 has not started. No commit or push was made.
