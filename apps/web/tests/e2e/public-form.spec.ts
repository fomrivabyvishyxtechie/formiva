import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOKEN = 'a'.repeat(64);
const URL = `/f/${TOKEN}`;
const API = `**/api/public/forms/${TOKEN}**`;

const form = {
  form: {
    id: '00000000-0000-4000-8000-000000000001',
    version_id: '00000000-0000-4000-8000-000000000002',
    slug: 'synthetic-onboarding',
    name: 'Synthetic onboarding',
    status: 'published',
    privacy_notice_version: 'synthetic-notice-v1',
    fields: [
      {
        field_key: 'full_name',
        label: 'Full name',
        field_type: 'text',
        required: true,
        sensitivity: 'internal',
        validation: {},
        position: 0,
      },
      {
        field_key: 'age',
        label: 'Age',
        field_type: 'number',
        required: false,
        sensitivity: 'internal',
        validation: {},
        position: 1,
      },
      {
        field_key: 'bank',
        label: 'Bank account',
        field_type: 'text',
        required: false,
        sensitivity: 'highly_sensitive',
        validation: {},
        position: 2,
      },
    ],
    slots: [
      {
        key: 'photo',
        label: 'Photo',
        required: false,
        allowed_mime_types: ['image/png'],
        max_size_bytes: 1000000,
        doc_class: 'photo',
      },
    ],
  },
  draft: { case_id: null, status: 'draft', draft_revision: 0, consent_recorded: false, values: {} },
  correlation_id: '00000000-0000-4000-8000-000000000003',
};

async function mockGet(page: Page, body: unknown = form, status = 200) {
  await page.route(API, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } else await route.fallback();
  });
}

test('shows the form, withholds unsupported fields, and passes axe', async ({ page }) => {
  await mockGet(page);
  await page.goto(URL);
  await expect(page.getByRole('heading', { name: 'Synthetic onboarding' })).toBeVisible();
  await expect(page.locator('#f-full_name')).toBeVisible();
  await expect(page.locator('#f-bank')).toHaveCount(0);
  await expect(page.locator('#s-photo')).toBeVisible();
  await expect(page.locator('#withheld-note')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('will not save without the privacy notice box, then saves with consent and the right body', async ({
  page,
}) => {
  await mockGet(page);
  const puts: unknown[] = [];
  await page.route(API, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    puts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        case_id: 'c',
        draft_revision: puts.length,
        status: 'draft',
        saved_at: 'now',
      }),
    });
  });
  await page.goto(URL);
  await page.locator('#f-full_name').fill('Synthetic Person');
  await page.locator('#f-age').fill('41');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#form-status')).toContainText('privacy notice');
  expect(puts).toHaveLength(0);

  await page.locator('#consent').check();
  await page.locator('#submit-btn').click();
  await expect(page.locator('#form-status')).toHaveText('Draft saved.');
  expect(puts[0]).toEqual({
    draft_revision: 0,
    values: { full_name: 'Synthetic Person', age: 41 },
    consent: { notice_version: 'synthetic-notice-v1', accepted: true },
  });

  // Second save: consent is not sent again and the revision moves on.
  await page.locator('#f-full_name').fill('Synthetic Person Two');
  await page.locator('#submit-btn').click();
  await expect(page.locator('#form-status')).toHaveText('Draft saved.');
  expect(puts[1]).toEqual({
    draft_revision: 1,
    values: { full_name: 'Synthetic Person Two', age: 41 },
  });
});

test('restores a saved draft without asking for consent again', async ({ page }) => {
  await mockGet(page, {
    ...form,
    draft: {
      case_id: 'c',
      status: 'draft',
      draft_revision: 2,
      consent_recorded: true,
      values: { full_name: 'Saved Person', age: 30 },
    },
  });
  await page.goto(URL);
  await expect(page.locator('#f-full_name')).toHaveValue('Saved Person');
  await expect(page.locator('#f-age')).toHaveValue('30');
  await expect(page.locator('#consent')).toHaveCount(0);
});

test('explains a stale draft (409) and an invalid link (404) without technical detail', async ({
  page,
}) => {
  await mockGet(page);
  await page.route(API, async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({ status: 409, contentType: 'application/problem+json', body: '{}' });
    else await route.fallback();
  });
  await page.goto(URL);
  await page.locator('#consent').check();
  await page.locator('#submit-btn').click();
  await expect(page.locator('#form-status')).toContainText('Reload the page');

  const other = await page.context().newPage();
  await mockGet(other, { status: 404 }, 404);
  await other.goto(URL);
  await expect(other.locator('.summary')).toContainText('not valid or has expired');
});

const saved = { ...form.draft, case_id: 'c', consent_recorded: true, draft_revision: 1 };
const withDraft = { ...form, draft: saved };
const SUBMIT = `**/api/public/forms/${TOKEN}/submit`;

async function mockPut(page: Page) {
  await page.route(`**/api/public/forms/${TOKEN}/draft`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ case_id: 'c', draft_revision: 2, status: 'draft', saved_at: 'now' }),
    }),
  );
}

test('submits: saves first, sends the revision and a key, then shows the confirmation (axe clean)', async ({
  page,
}) => {
  await mockGet(page, withDraft);
  await mockPut(page);
  const bodies: Array<{ draft_revision: number; idempotency_key: string }> = [];
  await page.route(SUBMIT, async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ case_id: 'c', status: 'submitted', job_ids: [], replay: false }),
    });
  });
  await page.goto(URL);
  await page.locator('#f-full_name').fill('Synthetic Person');
  await page.locator('#final-submit-btn').click();
  await expect(page.getByRole('heading', { name: 'Form submitted' })).toBeFocused();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.draft_revision).toBe(2);
  expect(bodies[0]!.idempotency_key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  await expect(page.locator('#f-full_name')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('does not send anything while a required answer is missing', async ({ page }) => {
  await mockGet(page, withDraft);
  let calls = 0;
  await page.route(`**/api/public/forms/${TOKEN}/(draft|submit)`, async (route) => {
    calls++;
    await route.abort();
  });
  await page.goto(URL);
  await page.locator('#final-submit-btn').click();
  await expect(page.locator('.summary')).toContainText('Full name');
  expect(calls).toBe(0);
});

test('explains a missing required file, and a retry after a failure reuses the same key', async ({
  page,
}) => {
  await mockGet(page, withDraft);
  await mockPut(page);
  const keys: string[] = [];
  let n = 0;
  await page.route(SUBMIT, async (route) => {
    keys.push(route.request().postDataJSON().idempotency_key);
    n++;
    if (n === 1) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          errors: [{ code: 'incomplete', message: 'Missing required answers: photo.' }],
        }),
      });
    } else {
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    }
  });
  await page.goto(URL);
  await page.locator('#f-full_name').fill('Synthetic Person');
  await page.locator('#final-submit-btn').click();
  await expect(page.locator('#form-status')).toContainText('Photo');
  await page.locator('#final-submit-btn').click();
  await expect(page.getByRole('heading', { name: 'Form submitted' })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('an already submitted link shows the confirmation, not the form', async ({ page }) => {
  await mockGet(page, { ...form, draft: { ...saved, status: 'submitted' } });
  await page.goto(URL);
  await expect(page.getByRole('heading', { name: 'Form submitted' })).toBeVisible();
  await expect(page.locator('#f-full_name')).toHaveCount(0);
});

test('a click on Submit still works after emptying a required field (the error line must not move the button)', async ({
  page,
}) => {
  await mockGet(page, withDraft);
  await page.route(`**/api/public/forms/${TOKEN}/(draft|submit)`, (route) => route.abort());
  await page.goto(URL);
  await page.locator('#f-full_name').fill('Synthetic Person');
  await page.locator('#f-full_name').fill('');
  await page.locator('#final-submit-btn').click();
  await expect(page.locator('.summary')).toContainText('Full name');
  await expect(page.locator('#form-status')).toContainText('Fix the answers');
});

// ---------- document upload (ADR-28) ----------
const STORAGE = 'https://storage.example.test/quarantine/abc';
const png = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from('synthetic image bytes'),
};
const doc = (state: string) => ({
  document_id: '00000000-0000-4000-8000-0000000000d1',
  slot_key: 'photo',
  filename: 'photo.png',
  size_bytes: 21,
  state,
});

/** Mocks the three upload routes. `states` is the list of states the documents list returns, one per call. */
async function mockUploads(page: Page, states: string[]) {
  const seen = { requests: [] as any[], puts: [] as any[], deletes: 0, lists: 0 };
  let uploaded = false;
  await page.route(`**/api/public/forms/${TOKEN}/documents`, async (route) => {
    const state = uploaded ? states[Math.min(seen.lists, states.length - 1)] : null;
    if (uploaded) seen.lists++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents: state ? [doc(state)] : [] }),
    });
  });
  await page.route(`**/api/public/forms/${TOKEN}/documents/*`, async (route) => {
    seen.deletes++;
    uploaded = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ document_id: 'x', state: 'removed' }),
    });
  });
  await page.route(`**/api/public/forms/${TOKEN}/upload-requests`, async (route) => {
    seen.requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        upload_id: 'u',
        document_id: doc('x').document_id,
        method: 'PUT',
        url: STORAGE,
        headers: { 'content-type': 'image/png' },
        expires_at: 'later',
        status: 'quarantine_pending',
        correlation_id: 'c',
      }),
    });
  });
  await page.route(STORAGE, async (route) => {
    seen.puts.push({
      headers: route.request().headers(),
      size: route.request().postDataBuffer()?.length,
    });
    uploaded = true;
    await route.fulfill({ status: 200, body: '' });
  });
  return seen;
}

test('uploads a file: saves the draft, sends only the file facts, then shows checking and ready (axe clean)', async ({
  page,
}) => {
  await mockGet(page, withDraft);
  await mockPut(page);
  const seen = await mockUploads(page, ['checking', 'ready']);
  await page.goto(URL);
  await page.locator('#s-photo').setInputFiles(png);
  await expect(page.getByText('photo.png: Checking this file…')).toBeVisible();
  await expect(page.getByText('photo.png: Received and checked')).toBeVisible({ timeout: 15_000 });
  expect(seen.requests).toHaveLength(1);
  expect(seen.requests[0]).toMatchObject({
    slot_key: 'photo',
    filename: 'photo.png',
    mime_type: 'image/png',
    size_bytes: png.buffer.length,
  });
  expect(seen.requests[0].masked_copy_confirmed).toBeUndefined();
  expect(seen.puts).toHaveLength(1);
  expect(seen.puts[0].headers['content-type']).toBe('image/png');
  expect(seen.puts[0].size).toBe(png.buffer.length);
  expect(seen.puts[0].headers['cookie']).toBeUndefined();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a file that is not accepted shows a plain message with no reason, and can be removed', async ({
  page,
}) => {
  await mockGet(page, withDraft);
  await mockPut(page);
  const seen = await mockUploads(page, ['not_accepted']);
  await page.goto(URL);
  await page.locator('#s-photo').setInputFiles(png);
  await expect(page.getByText(/This file was not accepted/)).toBeVisible();
  await expect(page.getByText(/virus|malware|quarantine|scan/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove photo.png' }).click();
  await expect(page.locator('#s-photo')).toBeFocused();
  expect(seen.deletes).toBe(1);
});

test('refuses a wrong type or an oversized file before anything is sent', async ({ page }) => {
  await mockGet(page, withDraft);
  const seen = await mockUploads(page, ['ready']);
  await page.goto(URL);
  await page
    .locator('#s-photo')
    .setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.locator('#s-photo-error')).toContainText('not allowed');
  await page
    .locator('#s-photo')
    .setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(1_000_001) });
  await expect(page.locator('#s-photo-error')).toContainText('too large');
  expect(seen.requests).toHaveLength(0);
});

test('a masked-copy document needs the confirmation box, shows its purpose, and sends the confirmation', async ({
  page,
}) => {
  const policy = {
    collect_mode: 'optional',
    require_masked: true,
    purpose: 'Synthetic purpose for this test.',
    retain_days: 30,
  };
  const slot = {
    ...form.form.slots[0],
    doc_class: 'identity',
    doc_subtype: 'voter_id',
    policy,
  };
  await mockGet(page, { ...withDraft, form: { ...form.form, slots: [slot] } });
  await mockPut(page);
  const seen = await mockUploads(page, ['checking']);
  await page.goto(URL);
  await expect(page.getByText('Why we ask: Synthetic purpose for this test.')).toBeVisible();
  await page.locator('#s-photo').setInputFiles(png);
  await expect(page.locator('#s-photo-error')).toContainText('masked copy');
  expect(seen.requests).toHaveLength(0);
  await page.locator('#s-photo-masked').check();
  await page.locator('#s-photo').setInputFiles(png);
  await expect(page.getByText('photo.png: Checking this file…')).toBeVisible();
  expect(seen.requests[0].masked_copy_confirmed).toBe(true);
});

test('Submit is blocked, with nothing sent, while a required file is missing or still being checked', async ({
  page,
}) => {
  const slot = { ...form.form.slots[0], required: true };
  await mockGet(page, { ...withDraft, form: { ...form.form, slots: [slot] } });
  await mockUploads(page, ['checking']);
  let submits = 0;
  await page.route(SUBMIT, async (route) => {
    submits++;
    await route.abort();
  });
  await page.goto(URL);
  await page.locator('#f-full_name').fill('Synthetic Person');
  await page.locator('#final-submit-btn').click();
  await expect(page.locator('.summary')).toContainText('Attach photo');
  await mockPut(page);
  await page.locator('#s-photo').setInputFiles(png);
  await expect(page.getByText('photo.png: Checking this file…')).toBeVisible();
  await page.locator('#final-submit-btn').click();
  await expect(page.locator('.summary')).toContainText('Wait until this file has been checked');
  expect(submits).toBe(0);
});
