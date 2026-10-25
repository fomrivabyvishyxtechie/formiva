# Evidence: Prompt 3.2 public respondent API

Built by Claude (chat session), not by the coding agent. Synthetic data only.

## Changed
- `apps/api/src/services/respondent-tokens.ts`, `rate-limiter.ts`, `log-redaction.ts`, `routes/public.ts`; wiring in `index.ts` (routes, 422/429/501 problem types, redacted `instance`, log serializer); `IP_HASH_SECRET` in `packages/config`.
- `tests/security/public-respondent.test.ts` (14 tests); CI runs `tests/security` with `--no-file-parallelism` (the migration runner has no lock).
- `docs/decisions/ADR-22-PROPOSED-public-respondent-api.md`, contract section 5 note.

## Verified (sandbox, PostgreSQL 16, port 55432)
- `pnpm run verify`: format, lint, typecheck, tests, build pass.
- `pnpm exec vitest run tests/security --no-file-parallelism`: 30 tests pass (tenant isolation 15, drift 1, public 14).

## Not verified
- Not run on the founder's Windows machine or in CI yet.
- No browser test: `/f/[token]` is not built.
- Rate limiter tested on one process only.
