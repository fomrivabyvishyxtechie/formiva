# Formiva CaseFlow API Contract v1.1

## Detailed REST/OpenAPI contract and step-by-step implementation guide

**Status:** Planned contract; implementation is not yet complete.  
**API code:** `apps/api`  
**Shared Zod/OpenAPI schemas:** `packages/contracts`  
**AI Engine:** `services/ai-engine`  
**Date:** 03 October 2026

> This is the single working API reference for the Formiva MVP. It consolidates REST, authentication, tenancy, database, intake, upload, review, approval, workflow, AI, integration, governance, and observability requirements. Examples use synthetic values only. A documented endpoint is not evidence that it already exists.

---

# 1. Governing baseline

| Area | Current decision |
|---|---|
| API | REST with OpenAPI 3.1, ADR-02. |
| Runtime | Fastify, Node.js, TypeScript, Zod. |
| Host | VM1: API, workers, scheduler, PostgreSQL, ClamAV, backups. |
| Frontend | Netlify free tier under the current Review Register/project decision. Older Vercel references are historical conflicts. |
| Authentication | Clerk JWT verification against JWKS. Clerk authenticates; Formiva authorizes workspace and role. |
| Database | PostgreSQL is the durable source of truth and dispatches jobs with leases. Valkey is optional only for cache/rate limits/short-lived locks. |
| Files | Cloudflare R2 quarantine and documents boundaries. Files are untrusted until scanned. |
| AI | Self-hosted AI Engine on VM2 only. AI output is advisory; backend recomputes routing. |
| Integrations | Resend first; signed webhooks, Google Sheets, and Razorpay later. All adapters use idempotency, safe mode, outcome classification, and credential references. |
| Data | Synthetic/redacted data during demo development. No real documents, IDs, credentials, secrets, or production dumps. |
| Government documents | Read/extract only; never authenticity verification. Masked Aadhaar only; full IDs never clear text. |

## 1.1 Authority and conflicts

Use this order: Review & Change Register/approved decisions, current ADRs, implementation, SQL/schema, Technical Documentation, `DESIGN.md`, PRD, Coding Plan, SOP, Business Plan, POC.

Known conflicts: older files contain Vercel/Pay-As-You-Go references; current decisions are Netlify/no paid infrastructure. AI v1.1 is specified more completely in Technical Documentation than the shorter PRD example. Database test counts differ and must be reconciled against actual SQL output. ADR-17 permits the synthetic demo before completed discovery but does not remove the sensitive-pilot gate. `DESIGN.md` was not found in the uploaded package; API behavior is defined here, but UI presentation must follow it when supplied.

## 1.2 Status labels

**Contracted** means required. **Planned** means defined but not implemented/evidenced. **Internal** means service-to-service only. **Verify** means provider behavior/term/limit needs checking. **Hypothesis** means measure before making a promise.

---

# 2. Non-negotiable API invariants

1. Workspace scope comes from authenticated membership, never the request body.
2. Every tenant transaction begins with transaction-local `app.set_context(workspace_id, user_id)` through `withTenant()`.
3. No raw database access outside `packages/db`; the app role is non-superuser and has no `BYPASSRLS`.
4. AI output is untrusted data. Validate it and recompute routing in the backend.
5. Timeouts, malformed output, missing models, low OCR, uncalibrated scores, unsafe files, and uncertainty never become approval.
6. Sensitive/irreversible actions never auto-execute; complete approval is required.
7. One business effect per workspace/idempotency key. Unknown provider outcomes go to lookup or human review, never blind retry.
8. AI results, evidence, routing decisions, corrections, consent records, scans, integration attempts, and audit events are append-only.
9. Highly sensitive values are ciphertext only and never logged. Aadhaar is masked; only last four may be displayed.
10. No secrets in code, logs, prompts, fixtures, URLs, OpenAPI examples, or the database; store references only.
11. Never edit an applied migration; add a new numbered migration.
12. Files are untrusted until scanned; quarantine content is scanner-only.
13. Government documents are read/extracted only, never authenticity-verified. Caste, community, and police documents are not sent to AI extraction.
14. Every connector implements validation, health check, dry run, execute, error classification, status lookup, redaction, safe mode, and idempotency.
15. Fail closed when tenant, role, policy, configuration, safety, or state is unknown.

---

# 3. Base paths and headers

```text
/public/v1       respondent-facing signed-link API; no Clerk login
/v1              authenticated workspace API; Clerk login required
/internal/v1     service-to-service only
/healthz         safe liveness/readiness response
/metrics         protected operational metrics
```

Common headers:

| Header | Required | Rule |
|---|---:|---|
| `Authorization` | `/v1` | `Bearer <Clerk JWT>`; validate issuer, audience, expiry, authorized party, signature. |
| `X-Request-Id` | Optional | Validate; generate if absent. |
| `X-Correlation-Id` | Optional | Generate if absent; propagate through all services/audit. |
| `Idempotency-Key` | Create-work POSTs | Stable business key; duplicate repeats return original safe result. |
| `Content-Type` | As applicable | Validate JSON, multipart, or provider content type. |
| `X-Workspace-Id` | Optional selector | Must match membership; never establishes authorization. |

Internal AI headers:

```text
X-Formiva-Timestamp
X-Formiva-Nonce
X-Formiva-Signature
X-Correlation-Id
```

Signature input: `METHOD + PATH + timestamp + nonce + sha256(body)`. Reject stale timestamps, reused nonces, wrong signature, body hash, or missing headers.

---

# 4. Request pipeline, authentication, and errors

## 4.1 Mandatory pipeline

1. Request/correlation ID.
2. Request size limit.
3. Rate limit.
4. Clerk authentication where required.
5. Workspace membership and selector validation.
6. Role/permission check, failing closed.
7. Zod validation of path/query/headers/body.
8. `withTenant()` for tenant-owned database work.
9. Policy and state-machine checks.
10. Minimal transaction.
11. Redacted audit event for each business state change.
12. Zod response validation in test/staging.
13. Safe response with correlation ID.

## 4.2 Problem Details

Use `application/problem+json`:

```json
{
  "type":"https://api.example.invalid/problems/validation-error",
  "title":"Request validation failed",
  "status":400,
  "detail":"One or more fields are invalid.",
  "correlation_id":"00000000-0000-4000-8000-000000000001",
  "errors":[{"field":"document_id","code":"invalid_uuid","message":"document_id must be a UUID."}]
}
```

Never expose SQL, stack traces, provider secrets, raw documents, prompts, or cross-tenant existence.

| Status | Meaning |
|---:|---|
| 200 | Successful read or safe idempotent repeat. |
| 201 | Resource created. |
| 202 | Accepted for durable asynchronous processing. |
| 204 | Success with no body. |
| 400 | Malformed request. |
| 401 | Missing/invalid authentication. |
| 403 | Authenticated but not authorized. |
| 404 | Absent or not visible in caller workspace. |
| 409 | State conflict, immutable version, or incompatible idempotency repeat. |
| 413 | Request/file too large. |
| 415 | Unsupported content/file type. |
| 422 | Semantic or policy rejection. |
| 429 | Rate limit; include `Retry-After`. |
| 500 | Safe generic internal error. |
| 503 | Dependency unavailable/not ready. |

## 4.3 Clerk and workspace authorization

The auth plugin verifies Clerk JWKS signature, issuer, audience, expiry/not-before, authorized party, and subject. Authentication identifies a user; it does not authorize a workspace. Resolve membership, validate the selector, set transaction-local context, query inside `withTenant()`, and rely on application authorization plus composite keys plus forced RLS. With no tenant context, tenant tables return zero rows. Foreign IDs return safe `404`.

Roles are `owner`, `admin`, `reviewer`, `approver`, `integration_operator`, `auditor`, and `viewer`. A reviewer cannot approve; an approver cannot review/export audit by default; an auditor cannot mutate; the last owner cannot be removed/demoted.

---

# 5. Public respondent API

Public routes use a hashed, signed respondent token scoped to a published form/version. They use no Clerk login.

## 5.1 `GET /public/v1/forms/{respondent_token}`

Returns a safe published form and draft state. Invalid/expired/revoked tokens return safe `404`. Never expose workspace/storage/model/audit internals or document text in URLs.

Example response:

```json
{
  "form":{"id":"00000000-0000-4000-8000-000000000030","version_id":"00000000-0000-4000-8000-000000000031","slug":"employee-onboarding","status":"published","fields":[{"key":"full_name","label":"Full name","type":"text","required":true}],"document_slots":[{"key":"pan","allowed_types":["tax"],"required":true,"policy_version":"onboarding-v3"}]},
  "draft":{"case_id":"00000000-0000-4000-8000-000000000032","status":"draft","consent_recorded":false,"values":{}},
  "correlation_id":"00000000-0000-4000-8000-000000000020"
}
```

## 5.2 `PUT /public/v1/forms/{respondent_token}/draft`

Saves draft values. Validate against the published version, record consent before values, encrypt highly sensitive fields, and never enqueue AI/actions.

```json
{"draft_revision":2,"consent":{"notice_version":"synthetic-notice-v1","accepted":true},"values":{"full_name":"Synthetic Person 001","joining_date":"2026-11-01"}}
```

Response includes `case_id`, new `draft_revision`, `status`, `saved_at`, and `correlation_id`.

## 5.3 `POST /public/v1/forms/{respondent_token}/upload-requests`

Creates a short-lived exact presigned upload to quarantine. Idempotency is required.

```json
{"idempotency_key":"synthetic-case-032:document:pan:1","slot_key":"pan","filename":"synthetic-pan-001.pdf","mime_type":"application/pdf","size_bytes":128000}
```

Response includes synthetic `upload_id`, `document_id`, method, short-lived URL, exact content type, expiry, and `quarantine_pending`. Do not return a permanent object key. Enforce size, extension, MIME, page, pixel, archive, decompression, and rate limits.

## 5.4 `POST /public/v1/forms/{respondent_token}/submit`

Atomically submits a draft and creates durable jobs. Required request:

```json
{"idempotency_key":"synthetic-case-032:submit:1","draft_revision":3,"consent":{"notice_version":"synthetic-notice-v1","accepted":true},"document_ids":["00000000-0000-4000-8000-000000000041"]}
```

One `withTenant()` transaction must resolve form/version; verify consent, revision, policy and clean scan; persist case/values/metadata/hashes; insert one `ai_jobs` row per document; and audit `case.submitted` before commit. Workers poll PostgreSQL after commit. Response `202` contains case ID, job IDs, status `submitted`, next action, and correlation ID. A crash leaves the complete transaction or none; identical repeat returns the original result.

---

# 6. Authenticated workspace, form, and case API

## 6.1 Workspace and members

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/v1/workspaces` | authenticated creator | Create workspace, owner, roles, default policy, audit. |
| GET | `/v1/workspaces/{workspace_id}/members` | owner/admin | List safe member metadata. |
| POST | `/v1/workspaces/{workspace_id}/members/invitations` | owner/admin | Create invitation reference. |
| PATCH | `/v1/workspaces/{workspace_id}/members/{member_id}` | owner/admin | Change role; protect last owner. |
| DELETE | `/v1/workspaces/{workspace_id}/members/{member_id}` | owner/admin | Remove membership and audit. |

Workspace request example: `{"name":"Synthetic Demo Workspace","slug":"synthetic-demo-workspace"}`. Never accept caller-supplied owner user ID.

The member list, role-change, and removal operations are implemented with JWT authentication, active workspace membership, the `member.manage` permission, and a workspace path that must match the selected tenant. Member responses contain only user ID, role, and status. Role changes and removals append audit events in the same tenant transaction; repeating an unchanged role or removal does not append another event. Only an owner can change/remove an owner, and the last active owner cannot be demoted or removed.

The invitation operation remains blocked: `workspace_members.status = 'invited'` has no invitation token/reference, expiry, or acceptance operation, so it cannot safely provide an invitation lifecycle. Workspace creation is also not yet operational for a new creator: the current route requires an existing membership, while the workspace RLS policy and `app.bootstrap_workspace` require the new workspace to already be the transaction context. Resolving either gap requires an approved schema/authorization design; do not change applied migrations or infer an invite-acceptance flow.

## 6.2 Forms and immutable versions

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/forms` | Create draft. |
| GET | `/v1/forms` | List workspace forms. |
| GET | `/v1/forms/{form_id}` | Read safe form/version metadata. |
| PATCH | `/v1/forms/{form_id}` | Edit draft only. |
| POST | `/v1/forms/{form_id}/versions` | Create draft version. |
| POST | `/v1/forms/{form_id}/versions/{version_id}/publish` | Validate and publish immutable version. |
| POST | `/v1/forms/{form_id}/versions/{version_id}/rollback` | Move active pointer and audit; never rewrite history. |

Reject invalid fields, missing policy, unsupported document classes, published-version edits, and foreign IDs.

## 6.3 Cases

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/cases` | Workspace-scoped paginated filtered list. |
| GET | `/v1/cases/{case_id}` | Safe metadata, status, workflow/version, SLA. |
| GET | `/v1/cases/{case_id}/timeline` | Correlation-linked redacted timeline. |
| POST | `/v1/cases/{case_id}/rework` | Request rework with reason. |
| POST | `/v1/cases/{case_id}/cancel` | Cancel only a legal state. |

Do not return raw document text, full IDs, credentials, or hidden policy internals.

### Request rework

`POST /v1/cases/{case_id}/rework` requires a valid JWT, active membership in the selected workspace, and the `case.approve` permission. The required request body is:

```json
{"reason":"Synthetic address evidence needs correction."}
```

The trimmed reason must be 3–500 printable characters and must not contain a full numeric ID or PAN-shaped value. The request also requires the `Idempotency-Key` header. Rework is allowed only when `app.state_transitions` defines a transition from the current case state to `review_queued`. In one tenant transaction, the API locks the case, changes its status to `review_queued`, and appends a `case.rework_requested` audit event containing the reason, state transition, correlation ID, and a SHA-256 fingerprint of the idempotency key. A failure rolls back both the state change and event.

Successful requests return HTTP 200:

```json
{"case_id":"00000000-0000-4000-8000-000000000032","status":"review_queued","correlation_id":"00000000-0000-4000-8000-000000000090"}
```

The reason and idempotency key are never returned. Repeating the same workspace-scoped key, case, and reason returns the original safe result without a second state change or audit event. Reusing the key for a different case or reason returns 409; a new request from a state without a legal transition also returns 409. Missing/invalid reason or key returns 400; missing authentication returns 401; missing permission returns 403; unknown and foreign cases both return 404. No migration is required: idempotency fingerprints are stored in the existing append-only audit event payload.

### Cancel a case

`POST /v1/cases/{case_id}/cancel` requires a valid JWT, active membership in the selected workspace, and the existing `case.approve` permission. It accepts the same required safe `reason` body and `Idempotency-Key` header as rework. The reason is trimmed, must be 3–500 printable characters, and must not contain a full numeric ID or PAN-shaped value.

Cancellation is allowed only when `app.state_transitions` defines a transition from the current status to `cancelled`. The API locks the tenant-scoped case row, updates its status, and appends the immutable `case.cancelled` audit event in the same tenant transaction. The event contains the reason, from/to statuses, correlation ID, and SHA-256 fingerprint of the idempotency key. A failure rolls back both the state change and audit event.

Successful requests return HTTP 200 with only the case ID, resulting status, and correlation ID:

```json
{"case_id":"00000000-0000-4000-8000-000000000032","status":"cancelled","correlation_id":"00000000-0000-4000-8000-000000000090"}
```

Repeating the same workspace-scoped key, case, and reason returns the original safe result without a duplicate transition or audit event. Reusing the key for a different case or reason, or attempting cancellation from a state without a legal transition, returns 409. Invalid reason or key returns 400; missing authentication returns 401; missing `case.approve` returns 403; unknown and foreign case IDs both return 404. The response never includes the reason or audit payload. No migration is required.

`GET /v1/cases/{case_id}/timeline` requires a valid JWT, active membership in the selected workspace, and `case.read`. It returns:

```json
{
  "items": [
    {
      "occurred_at": "2026-10-06T12:00:00.000Z",
      "correlation_id": "00000000-0000-4000-8000-000000000090",
      "event": "case_activity"
    }
  ]
}
```

Only case audit events with a correlation ID are included. Event actions are represented by the fixed `case_activity` label; actor details, reasons, audit payloads, object IDs, hashes, document text, credentials, and policy internals are not returned. Unknown and foreign case IDs return the same 404 response. Missing authentication returns 401; missing `case.read` returns 403.

## 6.4 Documents

### List documents for a case

`GET /v1/cases/{case_id}/documents` requires a valid JWT, active membership in the selected workspace, and `document.read_sensitive`. It returns `{ "items": [...] }` containing only the document ID, document class, processing status, latest scan result/time, whether a SHA-256 hash is available, retention state/deadline, and creation/update timestamps. An active legal hold is represented only as the `held` retention state.

The response does not include filenames, MIME types, hash values, bucket names, object keys, quarantine reasons, scan details/OCR, extracted values, or policy internals. Documents marked deleted are omitted. An existing case with no visible documents returns an empty list. Unknown and foreign case IDs both return 404; missing authentication returns 401 and missing `document.read_sensitive` returns 403. This operation does not create view links.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/cases/{case_id}/documents` | Safe metadata, scan/hash/retention state. |
| GET | `/v1/documents/{document_id}` | Metadata and evidence references. |
| POST | `/v1/documents/{document_id}/view-links` | Short-lived signed view URL, normally 60 seconds, watermarked. |
| POST | `/v1/documents/{document_id}/reprocess` | Durable reprocess job and audit. |
| POST | `/v1/documents/{document_id}/quarantine` | Quarantine unsafe/policy-blocked document. |

Viewing requires tenant-scoped object keys, restrictive content type, `Content-Disposition`, short expiry, watermark, masking by default, and audited reveal.

---

# 7. Review and approval API

## 7.1 Review tasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/review-tasks` | Filter by status, priority, due, assignee, reason. |
| GET | `/v1/review-tasks/{task_id}` | Read evidence, AI result, policy, safe case data. |
| POST | `/v1/review-tasks/{task_id}/claim` | Atomic claim with row version/lease. |
| POST | `/v1/review-tasks/{task_id}/release` | Release if allowed; audit. |
| POST | `/v1/review-tasks/{task_id}/correct` | Append correction and superseding route. |
| POST | `/v1/review-tasks/{task_id}/resolve` | Resolve task. |
| POST | `/v1/review-tasks/{task_id}/rework` | Return case for respondent rework. |

Correction request:

```json
{"row_version":3,"reason":"Synthetic fixture field was not grounded by OCR.","corrections":[{"field":"employer_name","value":"Synthetic Example Services","source":"human_correction"}]}
```

Original AI result/evidence remain unchanged. Insert correction, new value revision, superseding routing decision, and audit. Require reason and optimistic locking.

## 7.2 Approvals

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/cases/{case_id}/approvals` | Read rounds and safe decisions. |
| POST | `/v1/cases/{case_id}/approvals` | Create configured round. |
| POST | `/v1/approvals/{approval_id}/decide` | Approve/reject/delegate/rework. |
| POST | `/v1/approvals/{approval_id}/delegate` | Delegate with reason/audit. |

Decision example: `{"decision":"approve","reason":"Synthetic case passed review."}`. Rejection requires a reason. Sensitive/highly sensitive cases cannot enter `action_executing` without complete approval.

---

# 8. Internal AI Engine API

## 8.1 `POST /v1/ai/jobs`

Internal only; VM1 worker to VM2 through Cloudflare Access plus HMAC. Never accept an arbitrary public URL.

Request fields: `job_id`, `workspace_id`, `case_id`, `document_id`, `object_ref`, `mime_type`, `sha256`, `requested_tasks` (`ocr`, `language`, `classify`, `extract`, `route`), `allowed_classes`, `allowed_subtypes`, `policy_version`, `safe_mode`, and `trace_id`.

Synthetic example:

```json
{"job_id":"00000000-0000-4000-8000-000000000050","workspace_id":"00000000-0000-4000-8000-000000000011","case_id":"00000000-0000-4000-8000-000000000032","document_id":"00000000-0000-4000-8000-000000000041","object_ref":"r2://synthetic-documents/demo.pdf","mime_type":"application/pdf","sha256":"synthetic-sha256","requested_tasks":["ocr","language","classify","extract","route"],"allowed_classes":["identity","address","education","employment","bank","tax","photo","other"],"policy_version":"onboarding-v3","safe_mode":"review_sensitive_actions","trace_id":"00000000-0000-4000-8000-000000000090"}
```

Response must contain `status`, class/subtype, language, overall confidence, model/OCR/evidence/rule-agreement confidence components, calibration state, extractions with evidence references, source evidence references, sensitivity, advisory routing recommendation/reasons, prompt-injection signal, full-number signal, format checks, model ID/version/digest, OCR/runtime/engine versions, timings, and trace ID.

The backend validates schema, ownership, allowed class/policy, confidence, evidence, version, duplicates, prohibited classes, and clear-text IDs. It recomputes final routing. State is:

```text
queued -> claimed -> preprocessing -> ocr -> classifying -> extracted
       -> deterministic_check -> auto_proceed | human_review_required
transient -> retrying -> claimed
permanent/exhausted -> dead_letter or quarantine
unknown provider result -> lookup or human-authorized replay
```

Malformed output, timeout, low OCR, prompt injection, insufficient evidence, uncalibrated score, policy restriction, and sensitivity conflict never become approval.

---

# 9. Workflow and integration API

## 9.1 Workflows

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/workflows` | Create draft. |
| GET | `/v1/workflows` | List workspace workflows. |
| GET | `/v1/workflows/{workflow_id}` | Read metadata. |
| POST | `/v1/workflows/{workflow_id}/versions` | Create/edit draft version. |
| POST | `/v1/workflows/{workflow_id}/versions/{version_id}/lint` | Validate without external effects. |
| POST | `/v1/workflows/{workflow_id}/versions/{version_id}/dry-run` | Synthetic fixture, zero external writes. |
| POST | `/v1/workflows/{workflow_id}/versions/{version_id}/publish` | Publish immutable version. |
| POST | `/v1/workflows/{workflow_id}/rollback` | Point to existing immutable version. |

Reject unreachable nodes, invalid cycles, missing config/approval/error paths, forbidden side effects, unsupported connector scopes, unsafe idempotency, sensitive paths without human approval, and safe-mode incompatibility. Published versions cannot be edited.

## 9.2 Integrations

Every adapter implements `validateConfig`, `healthCheck`, `dryRun`, `execute`, `classifyError`, `lookupStatus`, and `redact`. The action sequence is validate → create interaction → claim → execution attempt → provider call → classify → lookup unknown → commit → audit → advance only when known.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/integrations/catalog` | Categories/templates, no credentials. |
| POST | `/v1/integrations/connections` | Create from credential references. |
| GET | `/v1/integrations/connections` | Safe metadata/health. |
| POST | `/v1/integrations/connections/{id}/health` | Health check. |
| POST | `/v1/integrations/connections/{id}/dry-run` | Test without business effect. |
| POST | `/v1/integrations/connections/{id}/safe-mode` | Block/test-only/review-sensitive/off. |
| GET | `/v1/integration-interactions/{id}` | Attempts/outcome, no secrets. |
| POST | `/v1/integration-interactions/{id}/lookup` | Resolve unknown outcome. |
| POST | `/v1/integration-interactions/{id}/replay` | Human-authorized replay with same key. |

Webhooks reject private/loopback/metadata targets and unsafe redirects. Sheets uses least privilege and idempotent rows. Razorpay uses raw-body signature verification, event-ID deduplication, reconciliation, and test mode during development.

---

# 10. Governance, health, and metrics API

## 10.1 Governance routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/audit-events` | Workspace-scoped redacted audit evidence. |
| GET | `/v1/audit-events/{event_id}` | Read one event if permitted. |
| POST | `/v1/audit-events/verify-chain` | Verify hash chain. |
| GET | `/v1/document-policies` | Read policy/version. |
| PUT | `/v1/document-policies` | Edit draft policy with purpose/audit. |
| POST | `/v1/document-policies/{version}/publish` | Publish immutable policy. |
| POST | `/v1/deletion-requests` | Request deletion/retention action. |
| GET | `/v1/deletion-requests` | Read status/evidence. |
| POST | `/v1/deletion-requests/{id}/approve` | Approve if role/legal hold permits. |
| POST | `/v1/deletion-requests/{id}/legal-hold` | Apply/release legal hold. |

Audit events are append-only, redacted, correlation-linked, hash chained, and daily anchored. Deletion checks legal hold, removes/anonymizes according to policy, may crypto-erase, and records proof without personal data in audit payloads.

## 10.2 Health and metrics

`GET /healthz` returns only safe status, service, version, and correlation ID. Protected readiness checks process, PostgreSQL/migration checksum, durable claim capability, worker heartbeat, AI protected connectivity, R2, Resend, and configuration without echoing values.

Protected `GET /metrics` covers request status/latency, auth/rate limits, queue age/lease/attempts/retries/dead letters/unknown outcomes, review backlog, AI/OCR/quarantine/calibration, connector outcomes, backup/restore/audit verification, CPU/memory/disk/temp/model storage, and safe mode. Alert thresholds are hypotheses until recorded/tested.

---

# 11. OpenAPI implementation rules

Use one source for runtime validation and OpenAPI:

```text
packages/contracts/src/common.ts
packages/contracts/src/errors.ts
packages/contracts/src/headers.ts
packages/contracts/src/forms.ts
packages/contracts/src/cases.ts
packages/contracts/src/documents.ts
packages/contracts/src/review.ts
packages/contracts/src/approvals.ts
packages/contracts/src/workflows.ts
packages/contracts/src/integrations.ts
packages/contracts/src/ai.ts
packages/contracts/src/openapi.ts
apps/api/src/routes/
docs/api/openapi.yaml
```

Generated OpenAPI must be 3.1, include placeholder servers, Clerk bearer security, common headers, Problem Details schemas, tags, request/response schemas, route security, common errors, and synthetic examples. CI fails when a route lacks an OpenAPI operation, schemas drift, a new route lacks tenant/permission tests, an undocumented state transition appears, or a secret-like value appears in examples.

---

# 12. Step-by-step API implementation roadmap

## Step 0 — Prepare

1. Create `docs/api/`.
2. Save this contract as `docs/api/Formiva_API_Contract_v1.1.md`.
3. Link it from `README.md` and `DECISIONS.md`.
4. Record status as planned/not implemented.
5. Confirm synthetic-only data, no new provider, and source conflicts.

**Exit evidence:** contract reviewed and linked.

## Step 1 — Minimal API scaffold

1. Create `apps/api` Fastify entry point.
2. Create `packages/contracts`, `packages/config`, `packages/observability`.
3. Add strict TypeScript and scripts.
4. Add `/healthz`.
5. Add safe environment validation that fails without echoing values.
6. Add problem response and correlation helpers.
7. Add unit tests and `make verify`.

**Exit:** clean clone passes install, lint, typecheck, tests, and secret scan.

## Step 2 — Request pipeline

1. IDs and correlation.
2. Size limits.
3. Rate-limit abstraction.
4. Zod request/response validation.
5. Problem responses and redaction.
6. Test 401/403/404/409/413/415/422/429/500/503.

**Exit:** pipeline/redaction tests pass.

## Step 3 — Authentication and tenancy

1. JWKS/JWT validation.
2. Membership lookup and selector.
3. Role permissions.
4. `withTenant()` context.
5. Two-workspace negative tests.
6. Audited workspace/member changes.

**Exit:** Phase 2 tenant suite passes and reviewer signs it.

## Step 4 — Workspace/forms/policies

1. Workspace bootstrap.
2. Member lifecycle/last-owner protection.
3. Form draft/version/publish/rollback.
4. Document-policy read/edit/publish.
5. OpenAPI and immutable-version tests.

## Step 5 — Public respondent flow

1. Token hashing/resolution.
2. Form read.
3. Consent and draft save/resume.
4. Upload request to quarantine.
5. Atomic submit transaction.
6. Mobile, rate-limit, expiry, hostile-file tests.

**Exit:** synthetic respondent reaches submitted case; no unscanned file/secret leak.

## Step 6 — Cases/review/approval

1. Case list/detail/timeline.
2. Signed view links and audited reveal.
3. Review queue/claim/correction/rework.
4. Approval rounds/decisions/delegation.
5. State, permission, append-only, and race tests.

## Step 7 — Durable jobs and AI

1. Worker claim/lease integration.
2. Internal HMAC AI endpoint.
3. Response ownership/schema/policy validation.
4. Append-only result/evidence storage.
5. Backend route recomputation.
6. Malformed/timeout/injection/uncalibrated/duplicate tests.

## Step 8 — Workflow/integrations

1. Workflow draft/lint/dry-run/publish/rollback.
2. Connector catalog and safe metadata.
3. Resend safe-mode adapter.
4. Later signed webhooks, Sheets, Razorpay after gates.
5. Unknown lookup/human replay.
6. SSRF/signature/replay/reliability tests.

## Step 9 — Governance/operations

1. Audit read/verify.
2. Retention/deletion/legal hold.
3. Metrics/readiness.
4. Health/safe-mode controls.
5. Backup/restore evidence and incident runbooks.
6. Alert tests.

## Step 10 — Release

1. Generate `docs/api/openapi.yaml` from code.
2. Tag release and write release notes.
3. Review migrations and create encrypted backup.
4. Run contract, tenancy, security, smoke, chaos, AI, and restore tests.
5. Publish only approved scope.
6. Update this document after every material change.
7. Use a new API version or ADR for breaking changes.

---

# 13. API test matrix

| Group | Required tests |
|---|---|
| Contract | Every route has Zod request/response schema and OpenAPI operation. |
| Authentication | Missing, malformed, expired, wrong issuer/audience, unknown user. |
| Authorization | Wrong workspace/role, foreign ID, last owner, reviewer cannot approve, auditor cannot mutate. |
| Validation | Bad UUID, wrong content type, oversized request, invalid state/policy. |
| Idempotency | Same repeat safe; same key/different body conflicts; provider replay ignored. |
| Upload | MIME mismatch, archive, decompression, page/pixel overflow, malware, quarantine escape. |
| AI | Bad HMAC, nonce replay, wrong hash, malformed output, missing evidence, injection, full ID, uncalibrated class. |
| State | Illegal case/job/review/workflow/integration transitions rejected. |
| Review | Claim race, missing reason, original evidence retained, reveal audited. |
| Approval | Incomplete approval blocks sensitive action; rejection/rework/delegation durable. |
| Integration | SSRF, signature, timeout, transient/permanent/unknown, lookup, replay, safe mode, duplicate effect. |
| Operations | Health/metrics redaction, queue/heartbeat/dead-letter, backup/restore evidence. |
| Privacy | No raw document text, secret, or full ID in logs, URLs, analytics, docs, or errors. |

---

# 14. Definition of done for an API route

A route is complete only when code exists; shared Zod schemas and generated OpenAPI exist; authentication, tenant scope, role, validation, audit, and idempotency are present where applicable; normal, negative, security, state, and failure tests pass; evidence is saved; no real data/secrets were used; required reviewer sign-off exists; and this contract is updated if behavior changed.

---

# 15. First implementation prompt

```text
Use Formiva_API_Contract_v1.1 and the project Master Context Block. Implement only API Step 1: the minimal compiling Fastify API and shared contract scaffold.

Before coding, list every file you will create or modify. Create apps/api, packages/contracts, packages/config and packages/observability entry points. Add strict TypeScript, Fastify, Zod, safe environment validation, correlation/request IDs, RFC 9457 problem responses, and GET /healthz. Do not implement Clerk, database routes, workspaces, forms, uploads, AI, workflows, integrations, billing, or UI. Do not add providers or servers. Use placeholders only and never echo secret values.

Add tests for /healthz, missing configuration, safe error serialization, correlation IDs, and secret redaction. Generate the OpenAPI placeholder only from shared schemas. Run make verify and report files changed, commands, tests, evidence path, and uncertainties.
```

**Do not proceed to authentication or database routes until this prompt passes on a clean clone.**

---

# Appendix A — planned file map

```text
apps/api/src/server.ts
apps/api/src/plugins/auth.ts
apps/api/src/plugins/request-context.ts
apps/api/src/plugins/rate-limit.ts
apps/api/src/routes/health.ts
apps/api/src/routes/public-forms.ts
apps/api/src/routes/workspaces.ts
apps/api/src/routes/forms.ts
apps/api/src/routes/cases.ts
apps/api/src/routes/documents.ts
apps/api/src/routes/review-tasks.ts
apps/api/src/routes/approvals.ts
apps/api/src/routes/workflows.ts
apps/api/src/routes/integrations.ts
apps/api/src/routes/governance.ts
packages/contracts/src/common.ts
packages/contracts/src/errors.ts
packages/contracts/src/headers.ts
packages/contracts/src/forms.ts
packages/contracts/src/cases.ts
packages/contracts/src/documents.ts
packages/contracts/src/review.ts
packages/contracts/src/approvals.ts
packages/contracts/src/workflows.ts
packages/contracts/src/integrations.ts
packages/contracts/src/ai.ts
packages/contracts/src/openapi.ts
packages/config/src/env.ts
packages/observability/src/logger.ts
packages/observability/src/correlation.ts
docs/api/openapi.yaml
tests/security/api-authorization.test.ts
tests/security/tenant-isolation.test.ts
tests/integration/api-contract.test.ts
```

Create these gradually by step; do not ask an AI coding tool to create the entire application in one prompt.
