'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { fileProblem, type Slot } from '../lib/form-logic';
import {
  STATE_TEXT,
  isPending,
  type SlotPolicy,
  type UploadedDoc,
  type Uploads,
} from '../lib/upload';

const POLL_MS = 4000;
// shortcut: stops after ~4 minutes so a stuck scanner is not polled forever; the person can reload.
const MAX_POLLS = 60;

/** The respondent's files for this link. Loads on mount (so a returning visit shows them) and polls while any is pending. */
export function useDocuments(uploads: Uploads | undefined) {
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const polls = useRef(0);

  const refresh = useCallback(async () => {
    const next = await uploads?.list();
    if (next) setDocs(next);
  }, [uploads]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = docs.some(isPending);
  useEffect(() => {
    if (!pending) {
      polls.current = 0;
      return;
    }
    if (polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void refresh();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [pending, docs, refresh]);

  return { docs, refresh };
}

export function UploadSlot({
  slot,
  docs,
  busyName,
  policy,
  error,
  describedBy,
  onPick,
  onRemove,
}: {
  slot: Slot;
  docs: UploadedDoc[];
  busyName: string | undefined;
  policy: SlotPolicy | undefined;
  error: string | undefined;
  describedBy: string | undefined;
  onPick: (file: File, masked: boolean) => Promise<string | null>;
  onRemove: (doc: UploadedDoc) => Promise<string | null>;
}) {
  const id = `s-${slot.key}`;
  const mb = Math.floor((slot.max_size_bytes / (1024 * 1024)) * 10) / 10;
  const [masked, setMasked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const needMasked = policy?.require_masked === true;

  async function change(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    setMessage(null);
    const local =
      needMasked && !masked ? 'Confirm that this is a masked copy first.' : fileProblem(slot, file);
    const problem = local ?? (await onPick(file, masked));
    if (problem) setMessage(problem);
    input.value = '';
  }

  async function remove(doc: UploadedDoc) {
    setMessage(await onRemove(doc));
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  const shownError = message ?? error;
  const picker = docs.length === 0 && !busyName;

  return (
    <div className="field">
      <label htmlFor={picker ? id : undefined} id={`${id}-label`}>
        {slot.required ? `${slot.label} (required)` : slot.label}
      </label>
      {policy?.purpose && <p className="hint">Why we ask: {policy.purpose}</p>}
      {needMasked && (
        <label className="checkbox-label" htmlFor={`${id}-masked`}>
          <input
            id={`${id}-masked`}
            type="checkbox"
            checked={masked}
            onChange={(e) => setMasked(e.target.checked)}
          />
          <span>This copy hides all but the last four digits of the ID number.</span>
        </label>
      )}
      {picker && (
        <input
          id={id}
          name={slot.key}
          type="file"
          accept={slot.allowed_mime_types.join(',')}
          aria-required={slot.required || undefined}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={
            [`${id}-hint`, shownError ? `${id}-error` : ''].filter(Boolean).join(' ') || describedBy
          }
          onChange={change}
        />
      )}
      <p className="hint" id={`${id}-hint`}>
        Accepted: {slot.allowed_mime_types.join(', ')}. Up to {mb} MB. One file.
      </p>
      {busyName && (
        <p className="note" role="status">
          {busyName}: {STATE_TEXT.uploading}
        </p>
      )}
      {docs.map((d) => (
        <p className="note" key={d.document_id}>
          <span role="status">
            {d.filename}: {STATE_TEXT[d.state]}
          </span>{' '}
          <button type="button" onClick={() => remove(d)} aria-label={`Remove ${d.filename}`}>
            Remove
          </button>
        </p>
      ))}
      {shownError && (
        <p className="error" id={`${id}-error`}>
          {shownError}
        </p>
      )}
    </div>
  );
}
