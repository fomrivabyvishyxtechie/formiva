# Evidence: Prompt 3.4 atomic submission

Built by Claude (chat session). Synthetic data only.

## Changed
- `apps/api/src/routes/public-submit.ts` (new), wired in `public.ts` (replaces the 501 stub).
- `visibleKeys` moved to `packages/contracts/src/forms.ts`; web re-exports it.
- Seed script adds an active routing policy; manual runbook has a submit step.
- Test: `tests/security/public-submit.test.ts` (10). `public-respondent.test.ts` updated (submit on an unknown link is now 404, not 501).
- ADR-26 (PROPOSED), API contract note.

## Verified (sandbox, PostgreSQL 16)
- Format, lint, typecheck, build clean; API unit 55, web unit 18, security 59 (all pass).
- Stale revision, missing consent/required answers (hidden conditional ones ignored), files still being checked, missing required file, no active policy: each refused with no case change and no job.
- Success: case `submitted` with policy version, one queued job per clean file with the file's SHA-256, rejected file excluded, audit event with no answers or file names.
- Repeat (same/new key) returns the same jobs; five simultaneous submits give exactly one submission and one audit event.

## Not verified
- Web UI submit button/page (none yet). Browser end-to-end tests were not re-run in the sandbox for this change (CI runs them).
- Behaviour with real storage/ClamAV. No AI engine consumes the jobs.
