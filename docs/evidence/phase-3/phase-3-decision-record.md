# Phase 3 decision record (DRAFT, unsigned)

Template: Master Build Roadmap, Appendix A. Numbers marked (re-run) were observed by the assistant on a rebuilt Linux PostgreSQL 16 on 2026-11-14; replace them with your own run before signing.

```text
Phase: 3 - Intake, forms, uploads and file safety
Release/fixture version: migrations 001-017; synthetic data only; corpus hash d34d7609573d67001bf5c51888bf9ccd772d7b265c5e0082fe70f83f8e71c224 (CORPUS_SHA256)
Date and time UTC: 2026-11-14 (fill in at sign-off)
Owner: Founder (VishyxTechie.in)
Technical reviewer: ______ (UNSIGNED - none appointed; review deferred by the founder to after all phases)
Scope completed: 3.1 forms and renderer, 3.2 public API/tokens/consent, 3.3 uploads and scanner worker, 3.4 atomic submit and web submit,
  3.5 Government Documents Policy, 3.6 browser upload control (ADR-28), 3.7 hardening after Test 3 (ADR-29 PROPOSED)

Controls implemented: hashed respondent tokens with rate limits and recorded consent; forced RLS and withTenant on every route; direct browser
  upload to a private quarantine bucket with signed content-type and size; scanner worker (byte-type check, size check, image metadata stripping,
  PDF/archive limits, ClamAV client) that promotes only clean files to the documents bucket; atomic submit blocked while any file is unchecked;
  document policies (read and extract only, masked Aadhaar only, caste/community/police always refused, ID numbers as ciphertext helper);
  respondent sees four states and never a reason; removal audited and, with ADR-29, the stored file deleted after 10 minutes.
Controls planned: retention for quarantined files; retry of a failed quarantine delete after promotion; first real use of the encryption helper;
  per-file upload progress (DESIGN.md); Hindi and Tamil text for new messages.
Controls assessment-required: security review of the scanner (in-house byte checks are a stated shortcut: PDFs are matched by name on raw bytes);
  key custody (open decision D-4); legal review of the Government Documents Policy and the privacy notice text.

Tests run and results:
  Exit test 3.1/3.2 (renderer, tokens, drafts, consent)    -> API/security suites and web e2e PASS (re-run)
  Exit test 3.3 (hostile files quarantined, clean promoted) -> Test 1: all 100 normal corpus documents promoted, 16 hostile files stopped, EXIF removed,
                                                             mutation check proved the test can fail (founder run on Windows)
  Test 2 real ClamAV 1.5.4                                  -> client works; EICAR signature matches only as the whole file; mid-file case removed and documented
  Exit test 3.4 (atomic submit, duplicate = one case)       -> PASS (re-run)
  Exit test 3.5 (policy in API/form, no clear ID numbers)   -> PASS (re-run); admin screen is Phase 4
  Test 3 real R2 upload (founder, 2026-11-08)               -> PASS: browser to R2, scanner, documents bucket, refusal of a non-image, submit, bucket not readable by browser (CORS)
  Test 4 phone walk-through                                 -> NOT RUN (founder deferred to the end)
  Whole suite (re-run 2026-11-14)                           -> format, lint, typecheck, build PASS; db 108 checks; db security 18; API 55; config 3; web unit 27;
                                                             tests/security 86 passed + 4 skipped (real ClamAV); web e2e 50
Attack/negative tests: foreign link, another respondent's file and another workspace's data return 404; after submit 409; hostile file corpus;
  wrong type or size refused before sending; reason never shown to the respondent; audit events contain no file names.
Evidence paths: docs/evidence/phase-3/ (prompt files 3.1a to 3.7), docs/runbooks/phase-3-exit-tests.md, tests/fixtures/generator/
Failed checks (found and fixed): Windows corpus hash (zip OS field); Windows Defender blocked the virus test string on disk; mid-file EICAR not detected by real ClamAV
  (test removed, finding recorded); slot `policy` broke strict form parsing; API/worker would not start on Windows; bucket setting with a web address crashed uploads;
  failed upload left an "uploading" row; removed files stayed in storage (ADR-29, not yet accepted).
Changed assumptions: ClamAV detects the EICAR signature only when it is the whole file; the scanner, not R2, is what enforces the declared size.
Open risks:
  1. Phase 2 reviewer sign-off and the 7 questions in docs/reviews/phase-2-reviewer-packet.md are still open (Phase 3 plan says "blocked until").
  2. ADR-27 and ADR-29 are PROPOSED; D-4 master key custody is open.
  3. Real R2 behaviour of the purge, R2 enforcing the signed size, and real ClamAV inside the full upload chain are unverified.
  4. Quarantined files are kept with no retention rule; a clean file whose quarantine copy failed to delete is not retried.
  5. Scanner PDF check is name matching on raw bytes (shortcut); not a security boundary on its own.
  6. DESIGN.md conformance of the form is checked by axe and layout tests only; no per-file progress bar; no screen-reader hand test; Hindi/Tamil strings not reviewed by native speakers.
  7. Python 3.12 CI run of the pinned corpus hash is not confirmed from CI.
  8. Exposed API/Clerk keys from earlier (founder item) must be rotated before any real deployment.
Decision: RESTRICTED
If restricted, allowed use: synthetic-data development and demos only; no customer data and no real government documents; no Phase 4 production use until the items above are cleared.
Next action and owner: founder accepts or rejects ADR-27 and ADR-29, runs Test 4 (phone), appoints a reviewer for Phases 2 and 3 - founder; assistant continues Phase 4 build on synthetic data.
```
