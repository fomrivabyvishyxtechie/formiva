// Browser side of document upload (ADR-28). The browser asks this site for a signed address,
// then sends the file straight to storage. This site never sees the file's bytes.

export type DocState = 'uploading' | 'checking' | 'ready' | 'not_accepted';
export type UploadedDoc = {
  document_id: string;
  slot_key: string;
  filename: string;
  size_bytes: number;
  state: DocState;
};
export type Result = { ok: boolean; message?: string };
export type SlotPolicy = { require_masked: boolean; purpose: string };

/** What the respondent reads. Internal reasons for a refusal are never shown. */
export const STATE_TEXT: Record<DocState, string> = {
  uploading: 'Uploading…',
  checking: 'Checking this file…',
  ready: 'Received and checked',
  not_accepted: 'This file was not accepted. Remove it and choose a different file.',
};

export const isPending = (d: UploadedDoc) => d.state === 'uploading' || d.state === 'checking';

const ERRORS: Record<string, string> = {
  consent_required: 'Tick the privacy notice box and save your draft first.',
  draft_required: 'Save your draft first.',
  masked_copy_required: 'Confirm that this is a masked copy first.',
  document_type_not_collected: 'This document is not collected on this form.',
  invalid_file: 'This file cannot be uploaded. Choose a different file.',
  too_many_files: 'Too many files for this form. Remove one first.',
};

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 429) return 'Too many requests. Wait a minute and try again.';
  if (res.status === 404) return 'This link is not valid or has expired.';
  const body = await res.json().catch(() => null);
  return ERRORS[body?.errors?.[0]?.code] ?? 'Could not upload this file. Try again.';
}

export function createUploads(token: string) {
  const base = `/api/public/forms/${token}`;
  return {
    async list(): Promise<UploadedDoc[] | null> {
      try {
        const res = await fetch(`${base}/documents`, { cache: 'no-store' });
        if (!res.ok) return null;
        const body = await res.json();
        return Array.isArray(body.documents) ? body.documents : null;
      } catch {
        return null;
      }
    },

    async start(slotKey: string, file: File, masked: boolean): Promise<Result> {
      try {
        const res = await fetch(`${base}/upload-requests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            slot_key: slotKey,
            filename: file.name,
            mime_type: file.type,
            size_bytes: file.size,
            ...(masked ? { masked_copy_confirmed: true } : {}),
          }),
        });
        if (!res.ok) return { ok: false, message: await errorMessage(res) };
        const grant = await res.json();
        // Send exactly the headers the address was signed with, and nothing else.
        const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: file });
        return put.ok
          ? { ok: true }
          : { ok: false, message: 'The upload did not finish. Try again.' };
      } catch {
        return {
          ok: false,
          message: 'The upload did not finish. Check your connection and try again.',
        };
      }
    },

    async remove(documentId: string): Promise<Result> {
      try {
        const res = await fetch(`${base}/documents/${documentId}`, { method: 'DELETE' });
        if (res.ok) return { ok: true };
        if (res.status === 409)
          return { ok: false, message: 'This file can no longer be removed.' };
        return { ok: false, message: await errorMessage(res) };
      } catch {
        return { ok: false, message: 'Could not remove the file. Try again.' };
      }
    },
  };
}
export type Uploads = ReturnType<typeof createUploads>;
