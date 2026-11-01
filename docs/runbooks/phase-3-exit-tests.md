# Phase 3 exit tests: goals and how to run them

Goal of Phase 3: a synthetic respondent can fill the form on a phone, upload files, and submit; unsafe files never reach AI. The roadmap's exit test has these checks. Run them in this order.

| # | Test | Goal | Status |
|---|------|------|--------|
| 1 | Hostile-file corpus through the scanner | Prove every bad file is refused or quarantined and no good file is falsely blocked | Automated (this runbook) |
| 2 | Real ClamAV | Prove a real antivirus flags the standard test string | Manual, needs Docker |
| 3 | Real R2 bucket upload | Prove the browser can upload to quarantine and the worker promotes it | Not runnable yet (needs ADR-28 and the upload control) |
| 4 | Mobile form walk-through | Complete, save, resume, upload, submit on a 375 px phone view | Not runnable yet (needs the upload control) |
| 5 | Government policy and no ID in clear text | Already automated in `tests/security/government-documents.test.ts` | Done (CI) |

## Test 1: corpus through the scanner (automated)
Goal: 100 normal documents are all accepted and promoted; all hostile files are stopped at the layer the manifest names, with the expected reason.
```powershell
cd C:\MAIN-DEV-ALL\Formiva
$env:DATABASE_URL = "postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test"
pnpm exec vitest run tests/security/hostile-corpus.test.ts --no-file-parallelism
```
Needs Python 3 on your PATH (`python --version`). Without it the test warns and skips locally; CI always runs it.
Pass = 4 tests pass. To look at the files yourself: `python tests\fixtures\generator\generate.py --out tests\fixtures\generated`.

## Test 2: real ClamAV (manual, about 15 minutes)
Goal: the fake antivirus used in the automated tests is replaced by the real ClamAV for one check: it must call ordinary bytes clean and the standard anti-virus test string infected. The test string stays in memory and is sent over localhost; no file is written, so Windows Defender has nothing to delete.

Needs Docker Desktop running and about 1.5 GB of free memory. (Image name and port are vendor claims, unverified: if a command fails, send me the message.)

Window A (starts the antivirus; the first start downloads its virus database and takes a few minutes):
```powershell
docker run -d --name formiva-clamav -p 3310:3310 clamav/clamav:stable
docker logs -f formiva-clamav
```
Watch the log until it says clamd has started (look for "socket found, clamd started" or the log going quiet), then press Ctrl+C. The container keeps running.

Window B (runs the check):
```powershell
cd C:\MAIN-DEV-ALL\Formiva
$env:CLAMD_PORT = "3310"
pnpm exec vitest run tests/security/clamav-live.test.ts
```
Pass = 4 tests pass. If you see "error" results, ClamAV is still loading: wait a minute and run again.
Clean up when finished: `docker stop formiva-clamav; docker rm formiva-clamav`.
Result recorded 2026-11-01 (ClamAV 1.5.4, signatures of 25 Oct 2026): the client works against the real clamd; the test string is flagged only when it is the whole file, not when buried in a larger file (that one test signature's behaviour; real malware signatures differ).
What this does NOT prove: it checks the scanner client against the real ClamAV, not the whole upload path (that is Test 3).

## Test 3: real storage upload (not runnable yet)
Goal: a real file goes from the browser to a private Cloudflare R2 "quarantine" bucket, the scanner worker checks it, and only a clean file reaches the "documents" bucket.
Needs, in order: ADR-28 accepted (how the browser may upload: CORS), the upload control built, two R2 buckets (quarantine and documents) with limited tokens, and the scanner worker running next to ClamAV. I will write these steps in full when the upload control is built; nothing to do before then except the R2 setup, which I will walk you through.

## Test 4: phone walk-through (not runnable yet)
Goal: on a 375 px wide phone screen, fill the form, save, close the page, come back from the link, upload a photo, submit, and see the confirmation. Needs the upload control. Steps follow the existing browser steps in `manual-test-public-form.md`, plus the upload.
