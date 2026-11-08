# ADR-28: Browser upload control for the public form (Prompt 3.6)

Status: ACCEPTED by the founder on 2026-11-01 (chat reply "Accept recommended" to the recommended option). Written by the agent. Builds on ADR-23, ADR-24, ADR-25, ADR-26 and ADR-27.
Date: 2026-11-01
Phase: 3

## Why
The API could already issue upload links, scan files and block submit until files are checked, but the web form showed "Files are not uploaded in this demo" and hid every file slot. A respondent could not attach a document, so the Phase 3 exit tests that need a real browser upload (Tests 3 and 4) could not run.

## Decision
1. **Direct upload.** The browser asks this site for a signed address (`POST /api/public/forms/<token>/upload-requests`, forwarded to the API) and then `PUT`s the file straight to the R2 quarantine bucket with exactly the headers it was signed with. The file never passes through the web server or the API (consistent with ADR-24).
2. **Bucket CORS (set by the founder in Cloudflare, per bucket).** AllowedOrigins: exactly the site origin, one origin per bucket, no wildcard. AllowedMethods: `PUT` only. AllowedHeaders: `content-type`. MaxAge: 3600. No `GET` or `HEAD`, so the quarantine bucket cannot be read from a browser. Development bucket: origin `http://localhost:3001` (the web dev server's port in the runbook).
3. **Content-Security-Policy.** Production `connect-src` is `'self'` plus one storage origin taken from the build-time variable `UPLOAD_CONNECT_ORIGIN` (plain `https` origin only; any other value is ignored, so a typo cannot widen the policy). The variable is read when the site is built, so changing it needs a new build.
4. **One file per slot, removable while draft.** `GET /public/v1/forms/{token}/documents` lists the respondent's files; `DELETE /public/v1/forms/{token}/documents/{document_id}` soft-deletes one (status `deleted`, audit event `document.removed` with no filename) and is refused (409 `not_draft`) after submit. A deleted file no longer blocks submit. Both routes are reached through the same-site proxy (ADR-23) and the proxy allow-list names only these paths.
5. **What the respondent sees.** Four states only: uploading, checking, ready, not accepted. Quarantine and rejection both show as "not accepted"; the internal reason is never returned by the API or shown.
6. **Submit rules in the form.** A required slot without a ready file, or any file still uploading or checking, blocks submit in the form (the API still enforces this with 409 `documents_not_ready`). Picking a file saves the draft first, because the API needs a draft and recorded consent. A slot whose policy requires a masked copy shows a confirmation box and the stated purpose; the box must be ticked before a file is sent.
7. **Checking is polled** every 4 seconds while any file is pending, for at most about 4 minutes per page visit. The scanner has no "complete" call (ADR-25), so the page reads the status; a returning visit lists existing files.
8. The API adds a `policy` object to a slot (ADR-27). The strict form definition does not allow it, so the page splits it off before validating. (This fixes a bug that would have made any form with a policy-bearing slot fail to render.)

## Known limits
- Removal is a soft delete. The object stays in storage until a retention or cleanup job exists (not built). Abandoned uploads (link issued, file never sent, or file sent and never submitted) are also left to that job.
- No upload progress bar: the page shows the state "Uploading…". DESIGN.md asks for per-file progress; this is a gap.
- Whether R2 enforces the signed `content-length` and the CORS rules exactly as described is a vendor claim, checked only by Test 3 with a real bucket.
- Drag and drop is not built; only the file picker. Screen-reader behaviour is checked by axe only, not by hand.
- Hindi and Tamil text for the new messages does not exist yet; the new strings are English only.
