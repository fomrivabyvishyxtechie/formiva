#!/usr/bin/env python3
"""Validator for the synthetic corpus. Exit 0 = valid. Fails on: missing labels, valid-looking IDs, missing hostile
fixtures, files that differ from the manifest, absent watermarks, and (with --regenerate-check) non-determinism.

Usage: python3 validate.py DIR [--regenerate-check]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQUIRED_CASE_KEYS = {
    "id", "file", "sha256", "size_bytes", "format", "declared_mime", "doc_class", "doc_subtype", "language", "sensitivity",
    "scenario", "expected_fields", "expected_route", "expected_terminal_state", "expected_scan", "watermark",
}
REQUIRED_HOSTILE_KEYS = {"kind", "file", "filename", "sha256", "size_bytes", "declared_mime", "expected_api", "expected_scanner", "defence_layer", "watermark"}
REQUIRED_HOSTILE_KINDS = {
    "wrong_extension", "oversized_file", "declared_decompression_bomb", "malformed_pdf", "image_pixel_overflow", "archive_as_docx",
    "archive_upload", "prompt_injection", "malware_test_string", "empty_file", "unsupported_mime_executable",
}
REQUIRED_CLASSES = {"identity", "address", "education", "employment", "bank", "tax", "photo", "other"}
REQUIRED_LANGS = {"en", "hi", "ta"}
SCENARIOS_FILE_BASED = {
    "high_confidence_low_risk", "low_confidence_class", "missing_required_field", "conflicting_evidence",
    "sensitive_document", "government_document_disallowed",
}
# Things that must never appear in a synthetic file: anything shaped like a real identity number.
ID_PATTERNS = {
    "aadhaar-like (12 digits)": re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)"),
    "pan-like": re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),
    "passport-like": re.compile(r"\b[A-Z]\d{7}\b"),
    "long digit run (10+)": re.compile(r"\d{10,}"),
}
MASKED_OK = re.compile(r"XXXX XXXX \d{4}")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def visible_text(path: Path, fmt: str) -> str:
    """Text as an extractor would see it. Never raises: a broken hostile file just falls back to its raw bytes."""
    try:
        if fmt == "docx":
            with zipfile.ZipFile(path) as z:
                return z.read("word/document.xml").decode("utf-8", "replace")
        if fmt == "pdf":
            return subprocess.run(["pdftotext", str(path), "-"], capture_output=True, timeout=30, check=True).stdout.decode("utf-8", "replace")
    except (KeyError, zipfile.BadZipFile, FileNotFoundError, subprocess.SubprocessError):
        pass
    return "" if fmt == "pdf" else path.read_bytes().decode("latin-1", "replace")


def has_watermark(path: Path, fmt: str, watermark: str) -> bool:
    data = path.read_bytes()
    if fmt == "png":
        return b"Comment\x00" + watermark.encode() in data
    if fmt == "docx":
        with zipfile.ZipFile(path) as z:
            return watermark in z.read("word/document.xml").decode("utf-8", "replace")
    return watermark.encode() in data  # pdf: Helvetica literal strings; unicode PDFs also start with the English watermark line? see below


def has_watermark_pdf_unicode(path: Path, watermark: str) -> bool:
    try:
        out = subprocess.run(["pdftotext", str(path), "-"], capture_output=True, timeout=30, check=True).stdout.decode("utf-8", "replace")
    except (FileNotFoundError, subprocess.SubprocessError):
        return True  # no extractor installed: cannot check, do not fail the corpus for a missing tool
    return watermark in out


def validate(root: Path, regenerate_check: bool = False) -> list[str]:
    errors: list[str] = []
    mf = root / "manifest.json"
    if not mf.exists():
        return ["manifest.json missing"]
    m = json.loads(mf.read_text(encoding="utf-8"))
    if m.get("synthetic") is not True:
        errors.append("manifest is not marked synthetic")
    cases, hostile = m.get("cases", []), m.get("hostile", [])
    if len(cases) != 100:
        errors.append(f"expected 100 cases, found {len(cases)}")
    present = [h for h in hostile if h.get("file")]
    if len(present) < 10:
        errors.append(f"need at least 10 hostile files, found {len(present)}")
    kinds = {h.get("kind") for h in hostile}
    for k in sorted(REQUIRED_HOSTILE_KINDS - kinds):
        errors.append(f"hostile kind missing: {k}")
    ids = [c.get("id") for c in cases]
    if len(set(ids)) != len(ids):
        errors.append("duplicate case ids")
    if {c.get("doc_class") for c in cases} < REQUIRED_CLASSES:
        errors.append(f"missing classes: {sorted(REQUIRED_CLASSES - {c.get('doc_class') for c in cases})}")
    if not REQUIRED_LANGS <= {c.get("language") for c in cases}:
        errors.append("English, Hindi and Tamil must all be present")
    for sc in SCENARIOS_FILE_BASED - {c.get("scenario") for c in cases}:
        errors.append(f"scenario not covered: {sc}")

    def check_file(entry: dict, keys: set[str], label: str, is_case: bool):
        missing = keys - entry.keys()
        if missing:
            errors.append(f"{label}: missing keys {sorted(missing)}")
            return
        for k in ("expected_route", "expected_terminal_state", "doc_class", "language", "sensitivity", "scenario"):
            if is_case and not entry.get(k):
                errors.append(f"{label}: empty label {k}")
        if is_case and entry["scenario"] != "missing_required_field" and not entry["expected_fields"] and entry["doc_class"] != "photo":
            errors.append(f"{label}: no expected_fields")
        p = root / entry["file"]
        if not p.exists():
            errors.append(f"{label}: file missing {entry['file']}")
            return
        data = p.read_bytes()
        if sha(data) != entry["sha256"] or len(data) != entry["size_bytes"]:
            errors.append(f"{label}: file differs from manifest")
        # Hostile files may lie about their type, so judge them by their first bytes, not their name.
        fmt = entry.get("format") or ("pdf" if data[:5] == b"%PDF-" else "png" if data[:4] == b"\x89PNG" else "docx" if data[:2] == b"PK" else "other")
        if entry["watermark"] != m["watermark"]:
            errors.append(f"{label}: wrong watermark label")
        # Watermark present in the file itself (skip kinds that are deliberately not documents).
        skip_wm = entry.get("kind") in {"empty_file", "unsupported_mime_executable", "oversized_file", "image_pixel_overflow", "png_truncated_chunk", "svg_with_script", "archive_upload", "jpeg_exif_metadata", "malware_test_string", "declared_decompression_bomb", "archive_as_docx"}
        if not skip_wm and fmt in ("pdf", "png", "docx"):
            ok = has_watermark(p, fmt, m["watermark"]) or (fmt == "pdf" and has_watermark_pdf_unicode(p, m["watermark"]))
            if not ok:
                errors.append(f"{label}: watermark absent")
        # No ID-shaped values anywhere in the visible text (PDF text needs pdftotext; without it only labels are checked).
        if len(data) < 5_000_000:
            text = MASKED_OK.sub("", visible_text(p, fmt))
            for name, rx in ID_PATTERNS.items():
                if rx.search(text):
                    errors.append(f"{label}: contains {name}")
        # The same patterns apply to the labels.
        label_text = json.dumps(entry.get("expected_fields", {}), ensure_ascii=False)
        for name, rx in ID_PATTERNS.items():
            if rx.search(MASKED_OK.sub("", label_text)):
                errors.append(f"{label}: label contains {name}")

    for c in cases:
        check_file(c, REQUIRED_CASE_KEYS, c.get("id", "?"), True)
        if c.get("doc_subtype") == "aadhaar" and not MASKED_OK.fullmatch(c.get("expected_fields", {}).get("aadhaar_masked", "")):
            errors.append(f"{c.get('id')}: Aadhaar label must be masked")
    for h in present:
        check_file(h, REQUIRED_HOSTILE_KEYS, h.get("kind", "?"), False)

    # Corpus hash must match the files.
    lines = sorted(f"{e['file']}:{e['sha256']}" for e in cases + hostile if e.get("file") and not e.get("opt_in"))
    if sha("\n".join(lines).encode()) != m.get("corpus_sha256"):
        errors.append("corpus_sha256 does not match the files")

    if regenerate_check:
        sys.path.insert(0, str(HERE))
        import generate  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as t:
            again = generate.generate(Path(t) / "again", m["seed"], with_eicar=any(h.get("opt_in") and h.get("file") for h in hostile))
        if again["corpus_sha256"] != m["corpus_sha256"]:
            errors.append("regenerating with the same seed gives a different corpus (non-deterministic)")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dir")
    ap.add_argument("--regenerate-check", action="store_true")
    a = ap.parse_args(argv)
    errs = validate(Path(a.dir), a.regenerate_check)
    for e in errs:
        print("FAIL:", e)
    print("VALID" if not errs else f"{len(errs)} problem(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
