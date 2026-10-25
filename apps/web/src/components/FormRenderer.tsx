'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  computeSchemaHash,
  formDefinitionSchema,
  validateFormDefinition,
  type FormDefinition,
} from '@formiva/contracts';
import {
  clearDraft,
  fieldError,
  getStore,
  isDraftable,
  loadDraft,
  optionsOf,
  saveDraft,
  serverSavable,
  slotError,
  visibleKeys,
  type Field,
  type FileInfo,
  type Slot,
  type Values,
} from '../lib/form-logic';

/** When set, answers are saved to the server draft (public link) instead of this browser. */
export type ServerDraft = {
  initialValues: Values;
  noticeVersion: string | null;
  consentRecorded: boolean;
  onSave: (values: Values, sendConsent: boolean) => Promise<{ ok: boolean; message?: string }>;
};

/** Outer component has NO hooks: it only decides whether the definition is usable. */
export function FormRenderer({
  definition,
  server,
}: {
  definition: unknown;
  server?: ServerDraft;
}) {
  const parsed = formDefinitionSchema.safeParse(definition);
  const check = validateFormDefinition(definition);
  if (!parsed.success || !check.valid) {
    return (
      <div role="alert" className="summary">
        <h2>This form cannot be shown</h2>
        <p>The form definition is not valid. Tell the person who sent you this link.</p>
      </div>
    );
  }
  return <ValidForm def={parsed.data} server={server} />;
}

type Problem = { id: string; label: string; message: string };

function ValidForm({ def, server }: { def: FormDefinition; server?: ServerDraft }) {
  const [values, setValues] = useState<Values>(server?.initialValues ?? {});
  const [consent, setConsent] = useState(false);
  const [consentDone, setConsentDone] = useState(server?.consentRecorded ?? false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileInfo | undefined>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempts, setAttempts] = useState(0);
  const [ready, setReady] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Work out the schema hash, then restore any saved (non-sensitive) answers.
  useEffect(() => {
    let live = true;
    if (server) {
      setLoaded(true); // the server holds the draft; the browser keeps nothing
      return;
    }
    computeSchemaHash(def).then((h) => {
      if (!live) return;
      setHash(h);
      setValues((prev) => ({ ...loadDraft(getStore(), h, def.fields), ...prev }));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [def, server]);

  // Save after every change, but only once the saved draft has been loaded (otherwise it would be wiped).
  useEffect(() => {
    if (loaded && hash) saveDraft(getStore(), hash, def.fields, values);
  }, [loaded, hash, def.fields, values]);

  const shown = visibleKeys(def.fields, values);
  const visibleFields = def.fields.filter(
    (f) => shown.has(f.field_key) && (!server || serverSavable(f)),
  );
  const withheld = server
    ? def.fields.some((f) => shown.has(f.field_key) && !serverSavable(f)) || def.slots.length > 0
    : false;

  const problems: Problem[] = [];
  const errorFor: Record<string, string> = {};
  for (const f of visibleFields) {
    const msg =
      f.field_type === 'file'
        ? fieldError(f, files[`f-${f.field_key}`] ? 'x' : '')
        : fieldError(f, values[f.field_key]);
    if (msg) {
      errorFor[`f-${f.field_key}`] = msg;
      problems.push({ id: `f-${f.field_key}`, label: f.label, message: msg });
    }
  }
  for (const s of server ? [] : def.slots) {
    const msg = slotError(s, files[`s-${s.key}`]);
    if (msg) {
      errorFor[`s-${s.key}`] = msg;
      problems.push({ id: `s-${s.key}`, label: s.label, message: msg });
    }
  }

  useEffect(() => {
    if (attempts > 0 && problems.length > 0) summaryRef.current?.focus();
    // Runs only when a submit is attempted (not on every keystroke).
  }, [attempts]);

  const showError = (id: string) => (attempts > 0 || touched[id] ? errorFor[id] : undefined);
  const touch = (id: string) => setTouched((t) => ({ ...t, [id]: true }));
  const setValue = (key: string, v: Values[string]) => {
    setReady(false);
    setValues((prev) => ({ ...prev, [key]: v }));
  };

  async function saveToServer() {
    if (!server) return;
    if (!consentDone && !consent) {
      setSaveMessage('Tick the privacy notice box before saving.');
      document.getElementById('consent')?.focus();
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    const result = await server.onSave(values, !consentDone);
    setSaving(false);
    if (result.ok) {
      setConsentDone(true);
      setSaveMessage('Draft saved.');
    } else {
      setSaveMessage(result.message ?? 'Could not save. Try again.');
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (server) {
      void saveToServer();
      return;
    }
    setAttempts((n) => n + 1);
    setReady(problems.length === 0);
  }

  function onClear() {
    if (hash) clearDraft(getStore(), hash);
    setValues({});
    setFiles({});
    setTouched({});
    setAttempts(0);
    setReady(false);
  }

  function onFile(id: string, e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setReady(false);
    touch(id);
    setFiles((prev) => ({
      ...prev,
      [id]: f ? { name: f.name, type: f.type, size: f.size } : undefined,
    }));
  }

  const describe = (id: string, extra: boolean) =>
    [extra ? `${id}-hint` : '', showError(id) ? `${id}-error` : ''].filter(Boolean).join(' ') ||
    undefined;

  return (
    <form noValidate onSubmit={onSubmit} aria-label="Employee details">
      {server ? (
        <p className="note">
          Your answers are saved to your private draft when you press Save draft. You can come back
          to this link to continue.
        </p>
      ) : (
        <p className="note">
          Your answers are saved on this device as you type, except sensitive answers and files.
          Nothing is sent anywhere in this demo.
        </p>
      )}
      {server && withheld && (
        <p className="note" id="withheld-note">
          File uploads and some protected fields cannot be answered yet. They are not shown here.
        </p>
      )}
      {server && !consentDone && (
        <div className="field">
          <label className="checkbox-label" htmlFor="consent">
            <input
              id="consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I have read the privacy notice
              {server.noticeVersion ? ` (version ${server.noticeVersion})` : ''} and agree that my
              answers are stored to process this form.
            </span>
          </label>
        </div>
      )}

      {attempts > 0 && problems.length > 0 && (
        <div
          id="error-summary"
          ref={summaryRef}
          tabIndex={-1}
          className="summary"
          aria-labelledby="error-summary-title"
        >
          <h2 id="error-summary-title">
            Fix {problems.length} {problems.length === 1 ? 'problem' : 'problems'} before you
            continue
          </h2>
          <ul>
            {problems.map((p) => (
              <li key={p.id}>
                <a
                  href={`#${p.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(p.id)?.focus();
                  }}
                >
                  {p.label}: {p.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {visibleFields.map((f) => (
        <FieldControl
          key={f.field_key}
          field={f}
          value={values[f.field_key]}
          error={showError(`f-${f.field_key}`)}
          describedBy={describe(`f-${f.field_key}`, !isDraftable(f))}
          onValue={(v) => setValue(f.field_key, v)}
          onBlur={() => touch(`f-${f.field_key}`)}
          onFile={(e) => onFile(`f-${f.field_key}`, e)}
        />
      ))}

      {(server ? [] : def.slots).map((s) => (
        <SlotControl
          key={s.key}
          slot={s}
          file={files[`s-${s.key}`]}
          error={showError(`s-${s.key}`)}
          describedBy={describe(`s-${s.key}`, true)}
          onFile={(e) => onFile(`s-${s.key}`, e)}
        />
      ))}

      <p>
        <button type="submit" id="submit-btn" disabled={saving}>
          {server ? (saving ? 'Saving…' : 'Save draft') : 'Continue'}
        </button>
        {!server && (
          <button type="button" id="clear-btn" onClick={onClear}>
            Clear saved answers
          </button>
        )}
      </p>
      <p role="status" id="form-status">
        {server ? (saveMessage ?? '') : ready ? 'Ready to submit (demo). Nothing was sent.' : ''}
      </p>
    </form>
  );
}

type FieldProps = {
  field: Field;
  value: Values[string] | undefined;
  error: string | undefined;
  describedBy: string | undefined;
  onValue: (v: Values[string]) => void;
  onBlur: () => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
};

function FieldControl({ field, value, error, describedBy, onValue, onBlur, onFile }: FieldProps) {
  const id = `f-${field.field_key}`;
  const common = {
    id,
    name: field.field_key,
    'aria-required': field.required || undefined,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': describedBy,
    onBlur,
  };
  const str = typeof value === 'string' ? value : '';
  const label = field.required ? `${field.label} (required)` : field.label;
  let control;
  switch (field.field_type) {
    case 'textarea':
      control = (
        <textarea {...common} rows={4} value={str} onChange={(e) => onValue(e.target.value)} />
      );
      break;
    case 'select':
      control = (
        <select {...common} value={str} onChange={(e) => onValue(e.target.value)}>
          <option value="">Choose one</option>
          {optionsOf(field).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'multiselect':
      control = (
        <select
          {...common}
          multiple
          value={Array.isArray(value) ? value : []}
          onChange={(e) => onValue(Array.from(e.target.selectedOptions, (o) => o.value))}
        >
          {optionsOf(field).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'checkbox':
      return (
        <div className="field">
          <label className="checkbox-label" htmlFor={id}>
            <input
              {...common}
              type="checkbox"
              checked={value === true}
              onChange={(e) => onValue(e.target.checked)}
            />
            <span>{label}</span>
          </label>
          <FieldNotes id={id} field={field} error={error} />
        </div>
      );
    case 'file':
      control = <input {...common} type="file" onChange={onFile} />;
      break;
    case 'signature':
      control = (
        <input
          {...common}
          type="text"
          autoComplete="off"
          value={str}
          onChange={(e) => onValue(e.target.value)}
        />
      );
      break;
    case 'date':
      control = (
        <input {...common} type="date" value={str} onChange={(e) => onValue(e.target.value)} />
      );
      break;
    case 'number':
      control = (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          value={str}
          onChange={(e) => onValue(e.target.value)}
        />
      );
      break;
    case 'email':
      control = (
        <input
          {...common}
          type="email"
          autoComplete="email"
          value={str}
          onChange={(e) => onValue(e.target.value)}
        />
      );
      break;
    case 'phone':
      control = (
        <input
          {...common}
          type="tel"
          autoComplete="tel"
          value={str}
          onChange={(e) => onValue(e.target.value)}
        />
      );
      break;
    default:
      control = (
        <input {...common} type="text" value={str} onChange={(e) => onValue(e.target.value)} />
      );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      <FieldNotes id={id} field={field} error={error} />
    </div>
  );
}

function FieldNotes({ id, field, error }: { id: string; field: Field; error: string | undefined }) {
  return (
    <>
      {field.field_type === 'signature' && (
        <p className="hint" id={`${id}-hint`}>
          Type your full name to sign. Not saved on this device.
        </p>
      )}
      {field.field_type !== 'signature' && !isDraftable(field) && (
        <p className="note" id={`${id}-hint`}>
          Not saved on this device.
        </p>
      )}
      {error && (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </>
  );
}

function SlotControl({
  slot,
  file,
  error,
  describedBy,
  onFile,
}: {
  slot: Slot;
  file: FileInfo | undefined;
  error: string | undefined;
  describedBy: string | undefined;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = `s-${slot.key}`;
  const mb = Math.floor((slot.max_size_bytes / (1024 * 1024)) * 10) / 10;
  return (
    <div className="field">
      <label htmlFor={id}>{slot.required ? `${slot.label} (required)` : slot.label}</label>
      <input
        id={id}
        name={slot.key}
        type="file"
        accept={slot.allowed_mime_types.join(',')}
        aria-required={slot.required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={onFile}
      />
      <p className="hint" id={`${id}-hint`}>
        Accepted: {slot.allowed_mime_types.join(', ')}. Up to {mb} MB. Not saved on this device.
        Files are not uploaded in this demo.
      </p>
      {file && !error && <p className="note">Chosen: {file.name}</p>}
      {error && (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
