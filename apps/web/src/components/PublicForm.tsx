'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formDefinitionSchema } from '@formiva/contracts';
import { fromApiValues, toApiValues, type Values } from '../lib/form-logic';
import { FormRenderer, type ServerDraft } from './FormRenderer';

type Loaded = {
  name: string;
  definition: unknown;
  noticeVersion: string | null;
  consentRecorded: boolean;
  revision: number;
  values: Record<string, unknown>;
};
type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'submitted'; name: string }
  | { kind: 'ready'; data: Loaded };

const MESSAGES: Record<number, string> = {
  404: 'This link is not valid or has expired. Ask the person who sent it for a new one.',
  429: 'Too many requests. Wait a minute and reload this page.',
};

/** Turns the API's "Missing required answers: a, b." into the labels the person sees. */
function missingLabels(detail: unknown, def: unknown): string {
  const parsed = formDefinitionSchema.safeParse(def);
  const names = new Map<string, string>();
  if (parsed.success) {
    for (const f of parsed.data.fields) names.set(f.field_key, f.label);
    for (const sl of parsed.data.slots) names.set(sl.key, sl.label);
  }
  const text = typeof detail === 'string' ? detail : '';
  const keys = text.includes(':') ? text.slice(text.indexOf(':') + 1).replace(/\.$/, '') : '';
  const labels = keys
    .split(',')
    .map((k) => names.get(k.trim()))
    .filter(Boolean);
  return labels.length > 0
    ? `These are still needed: ${labels.join(', ')}.`
    : 'Some required answers or files are still missing.';
}

export function PublicForm({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const revision = useRef(0);
  // One key per page visit: pressing Submit again after a network failure repeats the same request.
  const submitKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/forms/${token}`, { cache: 'no-store' });
        if (!res.ok) {
          if (live)
            setState({
              kind: 'error',
              message: MESSAGES[res.status] ?? 'The form could not be loaded. Try again later.',
            });
          return;
        }
        const body = await res.json();
        revision.current = body.draft?.draft_revision ?? 0;
        if (live && body.draft?.status && body.draft.status !== 'draft') {
          setState({ kind: 'submitted', name: String(body.form?.name ?? 'Your form') });
          return;
        }
        if (live) {
          setState({
            kind: 'ready',
            data: {
              name: String(body.form?.name ?? 'Your form'),
              definition: { fields: body.form?.fields, slots: body.form?.slots },
              noticeVersion: body.form?.privacy_notice_version ?? null,
              consentRecorded: body.draft?.consent_recorded === true,
              revision: revision.current,
              values: body.draft?.values ?? {},
            },
          });
        }
      } catch {
        if (live)
          setState({ kind: 'error', message: 'The form could not be loaded. Try again later.' });
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  const data = state.kind === 'ready' ? state.data : null;
  const fields = useMemo(() => {
    const parsed = data ? formDefinitionSchema.safeParse(data.definition) : null;
    return parsed?.success ? parsed.data.fields : [];
  }, [data]);

  const onSave = useCallback<ServerDraft['onSave']>(
    async (values: Values, sendConsent: boolean) => {
      if (!data) return { ok: false };
      const payload: Record<string, unknown> = {
        draft_revision: revision.current,
        values: toApiValues(fields, values),
      };
      if (sendConsent && data.noticeVersion) {
        payload.consent = { notice_version: data.noticeVersion, accepted: true };
      }
      try {
        const res = await fetch(`/api/public/forms/${token}/draft`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const body = await res.json();
          if (typeof body.draft_revision === 'number') revision.current = body.draft_revision;
          return { ok: true };
        }
        if (res.status === 409) {
          return {
            ok: false,
            message: 'This draft was changed somewhere else. Reload the page to continue.',
          };
        }
        if (res.status === 429) return { ok: false, message: MESSAGES[429] };
        if (res.status === 404) return { ok: false, message: MESSAGES[404] };
        return { ok: false, message: 'Could not save. Check your answers and try again.' };
      } catch {
        return { ok: false, message: 'Could not save. Check your connection and try again.' };
      }
    },
    [data, fields, token],
  );

  const onSubmit = useCallback<ServerDraft['onSubmit']>(async () => {
    try {
      const res = await fetch(`/api/public/forms/${token}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draft_revision: revision.current,
          idempotency_key: submitKey.current,
        }),
      });
      if (res.status === 202) {
        setState({ kind: 'submitted', name: data?.name ?? 'Your form' });
        return { ok: true };
      }
      const problem = await res.json().catch(() => null);
      const code = problem?.errors?.[0]?.code;
      if (res.status === 422 && code === 'incomplete')
        return { ok: false, message: missingLabels(problem.errors[0].message, data?.definition) };
      if (res.status === 409 && code === 'documents_not_ready')
        return { ok: false, message: 'Some files are still being checked. Try again in a moment.' };
      if (res.status === 409)
        return {
          ok: false,
          message: 'This form changed somewhere else. Reload the page to continue.',
        };
      if (res.status === 503)
        return { ok: false, message: 'Submitting is not available right now. Try again later.' };
      if (res.status === 429 || res.status === 404)
        return { ok: false, message: MESSAGES[res.status] };
      return { ok: false, message: 'Could not submit. Check your answers and try again.' };
    } catch {
      return { ok: false, message: 'Could not submit. Check your connection and try again.' };
    }
  }, [data, token]);

  const server = useMemo<ServerDraft | undefined>(
    () =>
      data
        ? {
            initialValues: fromApiValues(fields, data.values),
            noticeVersion: data.noticeVersion,
            consentRecorded: data.consentRecorded,
            onSave,
            onSubmit,
          }
        : undefined,
    [data, fields, onSave, onSubmit],
  );

  if (state.kind === 'loading') return <p role="status">Loading your form…</p>;
  if (state.kind === 'error') {
    return (
      <div role="alert" className="summary">
        <h1>Form unavailable</h1>
        <p>{state.message}</p>
      </div>
    );
  }
  if (state.kind === 'submitted') return <Submitted name={state.name} />;
  return (
    <>
      <h1>{state.data.name}</h1>
      <FormRenderer definition={state.data.definition} server={server} />
    </>
  );
}

function Submitted({ name }: { name: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="summary" role="status">
      <h1 ref={heading} tabIndex={-1}>
        Form submitted
      </h1>
      <p>Thank you. {name} has been submitted. You can close this page.</p>
    </div>
  );
}
