# Phase 3 Plan: Intake, Forms, Uploads, and File Safety

## Scope
The goal of Phase 3 is to enable a synthetic respondent to interact with a mobile form, save/resume, upload files, and submit only after files pass the safety pipeline.

## Prompts in Order
1.  **Prompt 3.1 — Forms and public renderer**
    - Exit Test: Mobile synthetic form is renderable, supports required fields, document slots, error messaging, navigation, and immutability of published versions.
2.  **Prompt 3.2 — Tokens, rate limits, consent**
    - Exit Test: Signed public tokens, draft saving, upload/submit routes are secure, rate-limited, and record consent.
3.  **Prompt 3.3 — Upload and scanner worker**
    - Exit Test: Hostile files are quarantined, clean files promoted with hash/metadata/audit. No unscanned files reach AI.
4.  **Prompt 3.4 — Atomic submission**
    - Exit Test: Submission is atomic. Duplicate submits create only one case.
5.  **Prompt 3.5 — Government Documents Policy**
    - Exit Test: Policy enforced in API, form, and admin. No clear-text ID numbers.

## Dependency on Phase 2 Invariants
- Tenant context via `withTenant`.
- Forced RLS (Row-Level Security).
- Append-only audit events.
- 404 for foreign identifiers.

## New Database Tables/Migrations
- Need to define tables for `form_definitions`, `form_submissions`, `file_scans`, `consent_records` (mark "needs a decision" if not clearly defined in existing schema).

## Security Tests (Security Route Coverage)
- Cross-tenant negative tests for all public and authenticated routes.
- Prompt injection tests for AI input.
- Malformed/hostile file upload tests.

## Synthetic Data/Gov Document Rules
- Use synthetic fixtures only; absolutely no real ID numbers.
- Aadhaar: masked copy only; ciphertext for IDs.
- Prohibited document classes: caste, community, police (no extraction).

## Open Questions
- Exact schema for `form_definitions`.
- Integration details for ClamAV.

## Blocked until
- Phase 2 reviewer sign-off.
- Ruling on the 7 questions in `docs/reviews/phase-2-reviewer-packet.md`.
