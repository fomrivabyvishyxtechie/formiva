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

## Test 3: real storage upload (manual, about 45 minutes, needs a Cloudflare account)
Goal: prove the whole chain with real storage. A real file goes from the browser to a private Cloudflare R2 "quarantine" bucket, the scanner worker checks it with the real ClamAV, and only a clean file reaches the "documents" bucket. It also proves two things I could only assume: that the bucket accepts the browser upload under the CORS rules in ADR-28, and that R2 refuses a file whose size does not match what was signed (both are vendor claims, unverified until you run this).

Do the parts in order. Use only fake files (any small PNG you make or download; never a real ID).

**Part A: storage (Cloudflare dashboard; menu names may differ, tell me if so)**
1. R2 > Create bucket: `formiva-quarantine-dev`. Create a second bucket: `formiva-documents-dev`. Leave both private (do not turn on public access or a public domain).
2. On `formiva-quarantine-dev` > Settings > CORS policy > add this, then save:
```json
[
  {
    "AllowedOrigins": ["http://localhost:3001"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```
No other origin, no `*`, no GET. Do not add CORS to the documents bucket.
3. R2 > Manage API tokens > Create API token: permission "Object Read & Write", limited to these two buckets only. Copy the Access Key ID and Secret Access Key into a text file kept OUTSIDE the repository. Never paste them into chat, a commit, or a screenshot. (Your account ID is on the R2 overview page.)

**Part B: start everything (four PowerShell windows, `C:\MAIN-DEV-ALL\Formiva`)**
Window 1: database and form link: same as `manual-test-public-form.md`, "Window 1". Keep the printed link.
Window 2: antivirus: `docker start formiva-clamav` (if you removed it, repeat Test 2 Window A).
Window 3: API: same as "Window 2" of `manual-test-public-form.md`, but with your real storage values instead of the fake ones:
```powershell
$env:R2_ACCOUNT_ID = "<your account id>"; $env:R2_ACCESS_KEY_ID = "<access key id>"
$env:R2_SECRET_ACCESS_KEY = "<secret access key>"; $env:R2_QUARANTINE_BUCKET = "formiva-quarantine-dev"
$env:R2_DOCUMENTS_BUCKET = "formiva-documents-dev"
```
Bucket settings are the bucket NAMES only (`formiva-quarantine-dev`), never the address shown on the Cloudflare page; the API now refuses to start with an address. Put the five R2 lines in one `.ps1` file outside the repository and load it in each window with `. "C:\path\formiva-r2-env.ps1"`.
Window 4: scanner worker (same database and storage values as the API, plus the antivirus):
```powershell
$env:DATABASE_URL = "postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test"
$env:CLAMD_HOST = "127.0.0.1"; $env:CLAMD_PORT = "3310"
# paste the same R2_* lines as Window 3, then the other settings the API needs (Clerk placeholders, IP_HASH_SECRET) exactly as in Window 3
cd apps\api
pnpm run scan-worker
```
Window 5: website: "Window 3" of `manual-test-public-form.md` (port 3001; the CORS origin above must match exactly).

**Part C: what to do in the browser (open the link from Window 1)**
1. Tick the privacy box, type a name, press Save draft.
2. At "Photo" choose a small PNG. Expect "photo.png: Checking this file…", then within about 10 seconds "Received and checked". PASS if both appear.
3. In the Cloudflare dashboard: the file must be in `formiva-documents-dev` and gone from `formiva-quarantine-dev`. PASS if so.
4. Choose a second fake file that is not a real PNG (rename a `.txt` to `.png`). Expect "This file was not accepted…" with no technical reason. Press Remove: the file box returns. PASS if both happen.
5. Press Submit form with a good file in place. Expect "Form submitted".
6. Open browser DevTools > Network during step 2. PASS if the PUT goes to `r2.cloudflarestorage.com`, and no file bytes go to `localhost`.
7. CORS check: in DevTools console on the form page run `fetch("https://<your-bucket-host>/anything")`. It must fail with a CORS error (no read access from a browser). FAIL if it returns data.

**Result, run by the founder on 2026-11-08 with real R2 (dev buckets):** steps 2, 3 (accepted file in the documents bucket, none left in quarantine), 5, 6 and 7 PASS; the not-accepted case PASS (a 34-byte text file declared as PNG stayed in quarantine, the respondent saw no reason). Found and fixed: API crashed when a bucket setting held a web address (now refused at start-up); Windows could not start the API or worker (entry check compared a Windows path with a file address); a failed upload left an "uploading" row (now removed). Found and fixed in ADR-29 (PROPOSED): removed files stayed in the documents bucket. Not tested: R2 enforcing the signed size (the scanner refuses a size mismatch anyway; covered by `tests/security/storage-purge.test.ts`), real ClamAV inside this chain.

**Pass:** steps 2 to 7 behave as written. **If step 2 shows "The upload did not finish":** open DevTools > Console/Network and send me the red message (usually the CORS origin does not match exactly, `http://localhost:3001` versus `http://127.0.0.1:3001`).
Clean up: delete the two dev buckets and the API token when finished, or keep them for Test 4.

## Test 4: phone walk-through (manual, about 20 minutes, after Test 3 passes)
Goal: on a real phone, fill the form, save, close the page, come back from the link, upload a photo, submit, and see the confirmation.

The phone cannot use `localhost`, and the CORS rule names one exact origin. So for this test only: find your PC's address on Wi-Fi (`ipconfig`, "IPv4 Address", for example `192.168.1.20`), change the CORS `AllowedOrigins` on `formiva-quarantine-dev` to `http://<that address>:3001`, restart Window 5 with `pnpm exec next dev -p 3001 -H 0.0.0.0`, and allow it through Windows Firewall if asked. Change CORS back to `localhost` afterwards.
1. On the phone (same Wi-Fi) open `http://<that address>:3001/f/<64 characters>`. The page must fit the screen with no sideways scrolling.
2. Save a draft, close the browser tab, open the link again: your answers are still there.
3. Take a photo with the phone camera at "Photo" (or pick one), wait for "Received and checked".
4. Submit. Expect "Form submitted".
PASS if all four work. Note anything that is hard to tap, hard to read, or confusing: that is the real result of this test.
