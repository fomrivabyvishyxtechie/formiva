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
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Loaded };

const MESSAGES: Record<number, string> = {
  404: 'This link is not valid or has expired. Ask the person who sent it for a new one.',
  429: 'Too many requests. Wait a minute and reload this page.',
};

export function PublicForm({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const revision = useRef(0);

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

  const server = useMemo<ServerDraft | undefined>(
    () =>
      data
        ? {
            initialValues: fromApiValues(fields, data.values),
            noticeVersion: data.noticeVersion,
            consentRecorded: data.consentRecorded,
            onSave,
          }
        : undefined,
    [data, fields, onSave],
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
  return (
    <>
      <h1>{state.data.name}</h1>
      <FormRenderer definition={state.data.definition} server={server} />
    </>
  );
}
