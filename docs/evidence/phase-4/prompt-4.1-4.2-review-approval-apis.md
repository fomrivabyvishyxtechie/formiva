# Prompts 4.1 and 4.2: review and approval APIs (evidence)

Date: 2026-11-15. Synthetic data only. Built and tested in the agent sandbox; not yet run on the founder's machine.

## Changed
- `apps/api/src/routes/reviews.ts`, `approvals.ts`, `route-helpers.ts`; contracts in `packages/contracts/src/reviews.ts`; `buildApp` accepts an optional `keyProvider`.
- `storeSensitiveValue` now returns the ciphertext and key id (it was not wired to any route before).
- No new migration: the Phase 4 tables already existed (004, 006).
- `tests/security/review-approvals.test.ts` (19 tests); `tenant-isolation.test.ts` extended for the 14 new routes.
- ADR-30 (PROPOSED), API contract notes, decision index.

## Exit tests covered
| Exit test | Test |
|---|---|
| Two reviewers cannot claim the same task | concurrent claim gives one 200 and one 409; live lease blocks, lapsed lease allows |
| Original AI result and evidence stay visible | row-for-row comparison before and after a correction; detail endpoint shows them |
| A correction creates new rows | revision 2 beside revision 1, two `human_corrections`, superseding routing decision |
| Rejection, delegation, rework are durable | decided rows are final (database refuses edits and deletes); delegation chain; rework opens a new task |
| Sensitive reveal checked and audited | 403/400/404/503 cases, audit row without the value |
| Timeline shows correlation-linked changes | `/activity` returns the sent correlation id; no reason or actor |
Mutation check: removing the lease condition from claim, and removing the round-closed check, each made tests fail.

## Decisions taken (flag for review)
- `/timeline` was left redacted on purpose (its existing unit test forbids action, reason, actor); the richer view is a new `/activity` route.
- A fully approved round does not move the case to `action_executing`; Phase 5 owns that. Until then such a case waits in `approval_pending`.
- `rework` to the respondent is not accepted by `resolve` (flow not built). Approval rework opens an internal review task.

## Security considerations
Reveal and sensitive correction need a key provider; none exists in production (D-4 open), so both answer 503 until key custody is decided. Ciphertext never appears in API responses or correction history. Masked by default for sensitive and highly sensitive values.

## Remaining risks / not built
- Escalated tasks leave the queue and no screen or route reopens them yet.
- The approver cannot be forced to differ from the person who created the round (no four-eyes rule specified).
- Signed document preview URLs (60 s) are not built; they need a download-sign method on the object store.
- Standing delegation windows (`approval_delegations`) are unused.
- Console (4.3) is blocked on ADR-30.
