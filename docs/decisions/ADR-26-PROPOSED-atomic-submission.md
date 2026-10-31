# ADR-26: Atomic submission (Prompt 3.4)

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-31
Phase: 3 (Prompt 3.4). Follows ADR-24 and ADR-25.

## Decision
1. `POST /public/v1/forms/{respondent_token}/submit` runs in one `withTenant` transaction. Body: `{ "draft_revision": <int>, "idempotency_key": "<8-64 chars A-Z a-z 0-9 _ ->" }`, nothing else.
2. Lock order matches the draft route: the respondent token row, then the case row (`FOR UPDATE`). Two simultaneous submits queue; the second sees the first one's result.
3. Checks, in order: case exists; case still `draft` (otherwise see 6); `draft_revision` equals the current revision (409); consent for the form's notice version is on record (422); every required field that is currently shown has an answer, using the shared `visibleKeys` rule from `@formiva/contracts` (422); no document is `pending_upload`, `uploaded` or `scanning` (409 `documents_not_ready`); every required slot has a `clean` document (422); the workspace has an active routing policy (503 `policy_unavailable`, fail closed).
4. On success: `cases.status = submitted`, `submitted_at`, `policy_version` set; one `ai_jobs` row (status `queued`) for each `clean` document, with that document's stored SHA-256 and the active policy version; audit `case.submitted` (counts, revision, policy version, idempotency key; no answers, no file names). Documents that are `quarantined` or `rejected` are left out and never sent on.
5. Response `202`: `case_id`, `status: submitted`, `job_ids`, `next_action: await_processing`, `replay`, `correlation_id`.
6. A repeat of a successful submit (same or different idempotency key, any revision) returns the original `case_id` and job IDs with `replay: true` and creates nothing. Job idempotency keys are `<client key>:<document id>`.
7. `visibleKeys` moved from the web app to `@formiva/contracts` so the browser and the API apply the same conditional-field rule. The web app re-exports it.
8. The policy version comes from the workspace's newest `routing_policies` row with status `active`. The local demo seed now creates one.

## Differences from the API Contract v1.1 section 5.4 (to be reconciled)
- The contract example sends `consent` and `document_ids` in the submit body. This build does not: consent is recorded at draft time (append-only `consent_records`) and verified at submit; all `clean` documents of the case are submitted. Reason: fewer client-controlled inputs, and a client cannot leave a clean file out of review. Decide whether the contract or the code should change.

## Consequences and known limits
- Any abandoned upload request (still `pending_upload`) blocks submit with 409 until the scanner rejects it (24 hours). There is no respondent-facing way to remove a file yet.
- Values are not re-validated against field rules at submit; they were validated when each draft was saved. Only required-ness is re-checked.
- Nothing consumes the queued jobs yet (AI engine integration is later).
- The respondent link keeps working after submit (GET shows status `submitted`); saves and uploads are refused.
