# ADR-24: Upload requests into quarantine (Prompt 3.3a)

Status: ACCEPTED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-25
Phase: 3 (Prompt 3.3a). The scanner worker is 3.3b.

## Decision
1. `POST /public/v1/forms/:token/upload-requests` creates a `case_documents` row in status `pending_upload` and returns a short-lived (300 s) presigned PUT link into the quarantine bucket. The file itself never passes through the API.
2. Accepted types: PDF, PNG, JPEG, Word `.docx`. Nothing else (no archives, no macro-enabled Word, no SVG/HTML). Extension, declared MIME type and the form slot's `allowed_mime_types` must agree. Size is limited by the slot and by 25 MB. At most 20 files per case.
3. Object key: `ws/<workspace_id>/cases/<case_id>/<document_id>` in the quarantine bucket. The response never contains the bucket or key as fields.
4. Preconditions: a saved draft (case exists), consent recorded for the form's notice version, case still `draft`. Otherwise `409 draft_required`, `422 consent_required`, `409 not_draft`.
5. Idempotency: required `idempotency_key`; only its SHA-256 is stored. Same key and same request returns the same document (`200`); a changed request returns `409 idempotency_conflict`.
6. Migration `015_upload_requests.sql` (additive): `case_documents.sha256` may be NULL until the scanner has read the stored file (checked: NULL only in pending/uploaded/quarantined/rejected/deleted), new `slot_key`, `idempotency_key_hash`, unique idempotency index.
7. Storage access goes through an `ObjectStore` interface; the real implementation uses the S3 API against Cloudflare R2 (Roadmap). Tests use a fake. Without `R2_*` settings the route answers `503`.
8. The audit event `document.upload_requested` holds document id, slot, MIME type and size only. The file name is never audited.

## Reasons
Roadmap and Security architecture require quarantine-only writes through exact presigned requests, and nothing unscanned readable by application or AI code. The document row has to exist before the file so the scanner has something to work from.

## Consequences
- Nothing moves a document out of `pending_upload` yet. 3.3b adds the worker that checks the object, scans it, sets sha256 and promotes or quarantines.
- Vendor claims to verify with a real R2 account before relying on them: S3-compatible endpoint `https://<account>.r2.cloudflarestorage.com`, path-style addressing, and that R2 rejects a PUT whose content type or length differs from what was signed. Until verified, the scanner must re-check size and type itself.
- `.docx` is a ZIP container. 3.3b must treat it as a special case (check it really is a Word file, enforce decompression limits) while generic ZIPs stay rejected.
- `upload_id` equals `document_id` (the contract lists both).
- Free-tier limits and terms for R2 are not verified here.
