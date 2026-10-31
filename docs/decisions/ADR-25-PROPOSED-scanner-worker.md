# ADR-25: Scanner worker and clean-file promotion (Prompt 3.3b)

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-31
Phase: 3 (Prompt 3.3b). Follows ADR-24.

## Decision
1. A separate process (`pnpm --filter @formiva/api scan-worker`) claims documents in `pending_upload` / `uploaded` with `ops.claim_next_document_scan` (migration 016: SECURITY DEFINER, `FOR UPDATE SKIP LOCKED`, lease, growing delay up to 1 hour between polls). Only the claim bypasses RLS; everything else the worker does runs inside the document's own workspace (`withTenant`). `formiva_worker` may execute the claim; `formiva_app` may not.
2. Per document: read object size (`head`) and compare with the signed size, read the object (max 25 MB), run in-house byte checks, send the same bytes to ClamAV (clamd INSTREAM), then decide.
3. Clean means all of: bytes match the declared type (magic bytes), image/PDF/ZIP limits pass, ClamAV says OK. Then the metadata-stripped bytes are written to the documents bucket under the same key, `case_documents` is updated (status `clean`, SHA-256 of the stored bytes, size, bucket, page count), one `document_scans` row per check is written, an audit event `document.scan_clean` is written (one transaction), and only then the quarantine copy is deleted.
4. Anything else is `quarantined` with a reason code (`type_mismatch`, `pixel_limit`, `page_limit`, `pdf_active_content`, `pdf_encrypted`, `pdf_malformed`, `office_macros`, `office_embedded_object`, `zip_*`, `decompression_*`, `size_mismatch`, `too_large`, `malware_detected`). Nothing is deleted from quarantine on a block.
5. If ClamAV or storage fails the file is never promoted. It is retried with backoff; after 8 attempts it is quarantined as `scan_unavailable`. A file that never arrives is `rejected` (`upload_expired`) after 24 hours.
6. Image metadata is stripped by rebuilding the file from the picture chunks only (PNG: IHDR/PLTE/tRNS/IDAT/IEND; JPEG: all segments except comments and APP1-APP15 other than Adobe APP14). Bytes after the end marker are dropped. The original file is not kept after promotion.
7. Limits (internal assumptions, need business confirmation): PDF 50 pages; image 12,000 px per side and 25 million pixels; DOCX 1,000 entries, 100 MB declared uncompressed, 200:1 ratio per entry; upload 25 MB.
8. New settings: `R2_DOCUMENTS_BUCKET`, `CLAMD_HOST` (default 127.0.0.1), `CLAMD_PORT` (default 3310).

## Reasons
Roadmap and Security architecture: quarantine-only writes, nothing unscanned readable by application or AI code, scan evidence and quarantine reasons recorded, clean files promoted to a tenant-scoped documents bucket.

## Consequences and known limits
- Byte checks are deliberately simple (no third-party parsers, nothing is rendered or unzipped). The PDF check matches raw names and can be evaded by escaped names or object streams; ClamAV is the second line. Replace with a real PDF parser before relying on it.
- Images are not decoded, so a file with a valid header and corrupt pixel data is accepted; it must never be rendered by trusted code.
- DOCX is inspected through its central directory only (no decompression). ZIP64 is refused.
- No other code reads `case_documents` rows to fetch files yet. Rule for later prompts: only read objects whose row is `clean` and whose bucket is the documents bucket.
- ClamAV protocol, its stream size limit, R2 behaviour and any Cloudflare free-tier limits are vendor claims not verified here; only a fake clamd and an in-memory store were used. EICAR in tests is assembled at run time.
- Not wired into `infra/vm1/docker-compose.yml`: `apps/worker/Dockerfile` is still a placeholder. The compose service for this process is a separate step.
- Promotion is not atomic across storage and database: if the process stops between the documents-bucket write and the database update, the document stays pending, is scanned again, and the object is overwritten; a leftover quarantine copy is possible only if the delete fails, and is harmless (never readable by application code).
