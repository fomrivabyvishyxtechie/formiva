# Prompt 3.6: browser upload control (ADR-28)

Date: 2026-11-01. Synthetic data only.

## What was built
- API: `GET /public/v1/forms/{token}/documents`, `DELETE /public/v1/forms/{token}/documents/{document_id}` (`apps/api/src/routes/public-documents.ts`).
- Web proxy: allow-list extended to `/upload-requests`, `/documents`, `/documents/<uuid>`; three new route files.
- Web: `lib/upload.ts` (browser calls), `components/UploadSlot.tsx` (control and polling), `FormRenderer`/`PublicForm` wiring, `policy` split off each slot before strict validation.
- `next.config.mjs`: optional production CSP `connect-src` origin from `UPLOAD_CONNECT_ORIGIN`.

## Tests added
- `tests/security/public-documents.test.ts` (5): state mapping with no reason leak; remove, idempotent, audited without filename; removed file no longer blocks submit; cross-respondent and cross-workspace isolation; after-submit 409 and 404s.
- `apps/web/src/lib/api-proxy.test.ts` (+2), `apps/web/src/lib/upload.test.ts` (6).
- `apps/web/tests/e2e/public-form.spec.ts` (+5, run at 375 px and 1280 px, axe clean on the upload page): upload to ready, not accepted then remove, wrong type or size refused before any request, masked-copy box and purpose (also proves a policy-bearing slot renders), submit blocked while a required file is missing or checking.

## Not proven here
- Real R2: CORS behaviour and signed content-length enforcement (vendor claims) are checked only by Test 3.
- Storage is mocked in the browser tests; the browser really sends a PUT with the signed headers to a fake address, nothing more.
- No hand test with a screen reader; no per-file progress bar; no Hindi/Tamil text for the new messages.
