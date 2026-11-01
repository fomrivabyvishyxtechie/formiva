# Synthetic corpus generator (Phase 0, Prompt 0.1)

Makes 100 labelled, **synthetic** onboarding documents plus 18 hostile files. Standard library only (Python 3.12+; `pdftotext` is used by the validator when present).

```
python3 generate.py --out ../generated            # default seed 20261101; add --with-eicar for the AV test string
python3 validate.py ../generated --regenerate-check
python3 -m unittest -v                            # generator + validator tests (about 15 s)
```
Output (`tests/fixtures/generated/`) is git-ignored. `CORPUS_SHA256` pins the expected corpus hash; change it only with a generator version bump and a decision record.

## What is in it
- 100 cases: identity (aadhaar, pan, passport, driving licence, voter id), address, education, employment, bank, tax, photo, other, including 4 placeholder files for document types a workspace policy must refuse. Languages: 63 English, 15 Hindi, 12 Tamil, 10 photos without text. Formats: text-layer PDF, DOCX (English employment letters), PNG (photos).
- Each case lists expected fields, class, sensitivity, scenario, expected route, expected terminal state and expected scan result in `manifest.json`.
- 18 hostile files: wrong extension, oversized, empty, executable header, SVG with script, plain archive, truncated PDF, encrypted PDF, PDF with JavaScript names, 51-page PDF, pixel-overflow PNG, truncated PNG, zip posing as Word, zip path traversal, Word macro part, declared-size zip bomb, JPEG with EXIF marker, prompt-injection PDF. The malware test string is opt-in.
- Every file is watermarked. No value is, or looks like, a real Aadhaar, PAN, passport or bank number; Aadhaar labels are masked (`XXXX XXXX nnnn`).

## Limits (honest list)
- Hindi/Tamil strings are not reviewed by native speakers, and the PDFs carry text without embedded glyphs: text extraction works, visual rendering depends on the viewer. This tests script handling, not OCR quality. The OCR benchmark (Phase 6) will need rendered samples.
- The PNG/JPEG files are synthetic drawings; the JPEG is structure-only (not decodable) and exists to test metadata stripping.
- The "bomb" files only claim large sizes in headers; nothing real expands.
- Routing expectations follow the roadmap's matrix; numeric thresholds are NOT here (pre-registered separately, Prompt 0.2). Only 6 of the 9 scenarios are file-based; malformed AI response, unknown external outcome and unsafe-file quarantine are covered by other tests.
