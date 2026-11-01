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
Pass = 5 tests pass. To look at the files yourself: `python tests\fixtures\generator\generate.py --out tests\fixtures\generated`.

## Test 2: real ClamAV (manual, later)
Goal: the fake antivirus used in tests is replaced by the real one for one check. Start ClamAV in Docker, generate with `--with-eicar`, scan `hostile\eicar.pdf`; expect "Eicar-Signature FOUND". Windows Defender may delete that file: that is expected and harmless; do it in a temporary folder.

## Tests 3 and 4
Written once the upload control exists (next step).
