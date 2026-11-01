# Evidence: Prompt 0.1 synthetic corpus generator

Built by Claude (chat session). Synthetic data only.

## Changed
- `tests/fixtures/generator/` (generate.py, validate.py, test_corpus.py, README, CORPUS_SHA256): 100 labelled cases + 18 hostile files, deterministic, watermarked.
- `tests/security/hostile-corpus.test.ts` (5 tests): runs the Python tests and validator, then feeds every file through the upload policy, content checks and the real scanner worker (fake ClamAV).
- `.gitignore` (generated output), `docs/runbooks/phase-3-exit-tests.md`.

## Verified (sandbox, Python 3.13, PostgreSQL 16)
- Same seed gives byte-identical corpus (hash pinned); different seed gives a different hash.
- Validator rejects: missing label, ID-shaped value, unmasked Aadhaar label, missing hostile kind, fewer than 10 hostile files, tampered/missing file, absent watermark, non-determinism (13 Python tests).
- All 100 normal documents accepted and promoted (no false positives). 16 hostile files stopped at upload policy or by the scanner with the expected reason; the EXIF JPEG is promoted with the marker stripped.
- Mutation check: disabling the PDF `/Encrypt` check makes the test fail (so the test can detect a regression).
- Security suite 75 pass; format, lint, typecheck clean; case-insensitive secret-scan regex clean.

## Not verified
- Real ClamAV (fake used), real R2, a decoder opening the files (JPEG is structure-only).
- Windows + Python 3.12 first run exposed two bugs, both fixed: zip entries recorded the OS (hash differed per machine; now pinned and tested) and the unit test wrote the AV test string to disk (Windows Defender blocked it; now never written in unit tests).
- Hindi/Tamil text not reviewed by native speakers; no glyph rendering, so no OCR use yet.
- Prompt injection and malware-string handling belong to later layers (AI Engine, ClamAV) and are listed, not tested.
- Prompt 0.1 asks for "at least 10 hostile files": met (18). The routing matrix signature and pre-registration (Prompt 0.2) are not done.
