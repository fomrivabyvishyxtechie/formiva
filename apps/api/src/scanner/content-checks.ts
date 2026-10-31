// In-house file checks (no third-party parsers). They look at bytes only; nothing is ever opened, rendered or unzipped.
// Limits are internal assumptions (ADR-25) and need business confirmation.
export const LIMITS = {
  maxPdfPages: 50,
  maxImageSide: 12_000,
  maxImagePixels: 25_000_000,
  maxZipEntries: 1_000,
  maxZipUncompressedBytes: 100 * 1024 * 1024,
  maxZipEntryRatio: 200,
} as const;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type CheckScanner = 'magic_sniff' | 'pdf_sanitizer' | 'image_limits' | 'archive_limits';
export interface CheckResult {
  scanner: CheckScanner;
  result: 'clean' | 'rejected' | 'suspicious';
  /** Short machine code; becomes the quarantine reason. Never contains file content. */
  reason?: string;
  details: Record<string, unknown>;
}
export interface FileChecks {
  checks: CheckResult[];
  /** Bytes to store if the file is clean (images are rebuilt without metadata). */
  output: Buffer;
  pageCount?: number;
}

const pass = (scanner: CheckScanner, details: Record<string, unknown> = {}): CheckResult => ({
  scanner,
  result: 'clean',
  details,
});
const fail = (
  scanner: CheckScanner,
  reason: string,
  details: Record<string, unknown> = {},
  result: 'rejected' | 'suspicious' = 'rejected',
): CheckResult => ({ scanner, result, reason, details });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Sniffed = 'pdf' | 'png' | 'jpeg' | 'zip' | 'unknown';
export function sniffType(buf: Buffer): Sniffed {
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  return 'unknown';
}

const MIME_TO_SNIFF: Record<string, Sniffed> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  [DOCX_MIME]: 'zip',
};

export function runContentChecks(buf: Buffer, declaredMime: string): FileChecks {
  const sniffed = sniffType(buf);
  const expected = MIME_TO_SNIFF[declaredMime];
  if (!expected || sniffed !== expected) {
    return {
      checks: [fail('magic_sniff', 'type_mismatch', { declared: declaredMime, sniffed })],
      output: buf,
    };
  }
  const checks: CheckResult[] = [pass('magic_sniff', { sniffed })];
  switch (sniffed) {
    case 'pdf': {
      const { check, pages } = checkPdf(buf);
      checks.push(check);
      return { checks, output: buf, pageCount: pages };
    }
    case 'png': {
      const { check, output } = checkPng(buf);
      checks.push(check);
      return { checks, output: output ?? buf };
    }
    case 'jpeg': {
      const { check, output } = checkJpeg(buf);
      checks.push(check);
      return { checks, output: output ?? buf };
    }
    default:
      checks.push(checkDocx(buf));
      return { checks, output: buf };
  }
}

// ---------------- PDF ----------------
// shortcut: name matching on raw bytes. A PDF can hide names with #xx escapes or inside object streams;
// ClamAV is the second line, and stored PDFs are never rendered by the application. Upgrade with a real PDF parser.
const PDF_RISKY = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/EmbeddedFile',
  '/RichMedia',
  '/XFA',
  '/OpenAction',
];

export function checkPdf(buf: Buffer): { check: CheckResult; pages: number } {
  const text = buf.toString('latin1');
  if (!buf.subarray(Math.max(0, buf.length - 2048)).includes('%%EOF')) {
    return {
      check: fail('pdf_sanitizer', 'pdf_malformed', { problem: 'no end marker' }),
      pages: 0,
    };
  }
  if (text.includes('/Encrypt')) {
    return { check: fail('pdf_sanitizer', 'pdf_encrypted'), pages: 0 };
  }
  const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  if (pages > LIMITS.maxPdfPages) {
    return { check: fail('pdf_sanitizer', 'page_limit', { pages }), pages };
  }
  const found = PDF_RISKY.filter((name) => new RegExp(`${name}(?![A-Za-z])`).test(text));
  if (found.length > 0) {
    return { check: fail('pdf_sanitizer', 'pdf_active_content', { found }, 'suspicious'), pages };
  }
  return { check: pass('pdf_sanitizer', { pages }), pages };
}

// ---------------- PNG ----------------
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

export function checkPng(buf: Buffer): { check: CheckResult; output?: Buffer } {
  let offset = 8;
  const kept: Buffer[] = [PNG_SIG];
  let width = 0;
  let height = 0;
  let sawEnd = false;
  let first = true;
  const dropped: string[] = [];
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length)
      return { check: fail('image_limits', 'image_malformed', { problem: 'truncated chunk' }) };
    if (first) {
      if (type !== 'IHDR' || length !== 13)
        return { check: fail('image_limits', 'image_malformed') };
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      first = false;
    }
    if (PNG_KEEP.has(type)) kept.push(buf.subarray(offset, end));
    else dropped.push(type);
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return { check: fail('image_limits', 'image_malformed', { problem: 'no IEND' }) };
  const limit = imageLimit(width, height);
  if (limit) return { check: limit };
  const trailing = buf.length - offset;
  return {
    check: pass('image_limits', {
      width,
      height,
      droppedChunks: dropped.length,
      trailingBytes: trailing,
    }),
    output: Buffer.concat(kept),
  };
}

function imageLimit(width: number, height: number): CheckResult | null {
  if (width <= 0 || height <= 0) return fail('image_limits', 'image_malformed', { width, height });
  if (
    width > LIMITS.maxImageSide ||
    height > LIMITS.maxImageSide ||
    width * height > LIMITS.maxImagePixels
  ) {
    return fail('image_limits', 'pixel_limit', { width, height });
  }
  return null;
}

// ---------------- JPEG ----------------
export function checkJpeg(buf: Buffer): { check: CheckResult; output?: Buffer } {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  let droppedSegments = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xff)
      return { check: fail('image_limits', 'image_malformed', { problem: 'bad marker' }) };
    while (buf[i + 1] === 0xff) i++; // fill bytes
    const marker = buf[i + 1];
    if (marker === undefined) break;
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      sawEnd = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return { check: fail('image_limits', 'image_malformed') };
    const length = buf.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > buf.length)
      return { check: fail('image_limits', 'image_malformed', { problem: 'bad segment' }) };
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    // Drop comments and APP1..APP15 (EXIF, XMP, ICC, ...) except Adobe's APP14 colour flag.
    const drop = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee);
    if (drop) droppedSegments++;
    else out.push(buf.subarray(i, end));
    i = end;
    if (marker === 0xda) {
      let j = i;
      while (j + 1 < buf.length) {
        if (buf[j] === 0xff) {
          const next = buf[j + 1]!;
          if (next === 0xff) {
            j++;
            continue;
          }
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        j++;
      }
      out.push(buf.subarray(i, j));
      i = j;
    }
  }
  if (!sawEnd)
    return { check: fail('image_limits', 'image_malformed', { problem: 'no end marker' }) };
  const limit = imageLimit(width, height);
  if (limit) return { check: limit };
  return {
    check: pass('image_limits', { width, height, droppedSegments }),
    output: Buffer.concat(out),
  };
}

// ---------------- DOCX (a ZIP container; read-only inspection of the central directory) ----------------
const RISKY_EXT = /\.(exe|dll|bat|cmd|com|scr|js|vbs|ps1|msi|jar)$/i;

export function checkDocx(buf: Buffer): CheckResult {
  const scanner = 'archive_limits';
  const tail = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= tail; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail(scanner, 'zip_malformed', { problem: 'no end record' });
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return fail(scanner, 'zip64_unsupported');
  }
  if (count > LIMITS.maxZipEntries) return fail(scanner, 'zip_entry_limit', { entries: count });
  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      return fail(scanner, 'zip_malformed', { problem: 'bad directory' });
    }
    const flags = buf.readUInt16LE(p + 8);
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLength > buf.length) return fail(scanner, 'zip_malformed');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) return fail(scanner, 'zip_encrypted');
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      return fail(scanner, 'zip_unsafe_path');
    }
    if (RISKY_EXT.test(name)) return fail(scanner, 'zip_executable_content', {}, 'suspicious');
    if (/vbaProject\.bin$/i.test(name)) return fail(scanner, 'office_macros', {}, 'suspicious');
    if (name.startsWith('word/embeddings/'))
      return fail(scanner, 'office_embedded_object', {}, 'suspicious');
    total += uncompressed;
    if (total > LIMITS.maxZipUncompressedBytes)
      return fail(scanner, 'decompression_limit', { bytes: total });
    if (
      uncompressed > 1024 * 1024 &&
      uncompressed / Math.max(compressed, 1) > LIMITS.maxZipEntryRatio
    ) {
      return fail(scanner, 'decompression_ratio');
    }
    names.add(name);
  }
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    return fail(scanner, 'not_a_word_document');
  }
  return pass(scanner, { entries: count, uncompressedBytes: total });
}
