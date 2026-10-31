// What a respondent may upload. Deliberately small: no archives, no macro-enabled Office files, no images with
// scripting formats (SVG), no HTML. Real content checks (magic bytes, limits, ClamAV) happen in the scanner (3.3b);
// this only rejects obviously wrong requests early.
export const ALLOWED_UPLOADS: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_CASE = 20;

/** Safe display name: no path, no control or odd characters, at most 100 characters. Null when unusable. */
export function sanitizeFilename(raw: string): { name: string; ext: string } | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._ ()-]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-100);
  const dot = cleaned.lastIndexOf('.');
  if (dot < 1 || dot === cleaned.length - 1) return null;
  return { name: cleaned, ext: cleaned.slice(dot + 1).toLowerCase() };
}

export function checkUpload(input: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  slotMimeTypes: readonly string[];
  slotMaxBytes: number;
}): { ok: true; name: string } | { ok: false; message: string } {
  const file = sanitizeFilename(input.filename);
  if (!file) return { ok: false, message: 'File name is not usable.' };
  const expected = ALLOWED_UPLOADS[file.ext];
  if (!expected) return { ok: false, message: 'This file type is not accepted.' };
  if (input.mimeType !== expected)
    return { ok: false, message: 'File type does not match its name.' };
  if (!input.slotMimeTypes.includes(input.mimeType)) {
    return { ok: false, message: 'This slot does not accept that file type.' };
  }
  if (input.sizeBytes <= 0) return { ok: false, message: 'File is empty.' };
  if (input.sizeBytes > Math.min(input.slotMaxBytes, MAX_UPLOAD_BYTES)) {
    return { ok: false, message: 'File is too large.' };
  }
  return { ok: true, name: file.name };
}
