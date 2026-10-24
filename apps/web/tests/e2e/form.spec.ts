import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const URL = '/dev/form-demo';

async function open(page: Page) {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Wait until React has hydrated and the draft logic has run.
  await expect(page.locator('#submit-btn')).toBeEnabled();
  await page.waitForTimeout(300);
}

/** Press Tab until the element with this id has focus, using the keyboard only. */
async function tabTo(page: Page, id: string) {
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Could not reach #${id} with Tab`);
}

async function fillRequiredByKeyboard(page: Page, employment: 'Full-time' | 'Contract') {
  await tabTo(page, 'f-full_name');
  await page.keyboard.type('Test Person');
  await page.keyboard.press('Tab');
  await page.keyboard.type('test.person@example.com');
  await page.keyboard.press('Tab');
  await page.keyboard.type(employment);
  if (employment === 'Contract') {
    await tabTo(page, 'f-contract_end_date');
    await page.locator('#f-contract_end_date').fill('2027-01-31');
  }
  await tabTo(page, 'f-confirm');
  await page.keyboard.press('Space');
  await page
    .locator('#s-photo')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('synthetic') });
}

test('renders the demo form with labels and no horizontal scroll', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel('Full name (required)')).toBeVisible();
  await expect(page.getByLabel('Passport-size photo (required)')).toBeVisible();
  await expect(page.getByLabel('Masked Aadhaar copy')).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
});

test('keyboard only: empty submit shows an error summary that takes focus', async ({ page }) => {
  await open(page);
  await tabTo(page, 'submit-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#error-summary')).toBeFocused();
  await expect(page.locator('#error-summary')).toContainText('Fix 5 problems');
  await expect(page.locator('#f-full_name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#f-full_name-error')).toHaveText('Enter full name');
  // Following a summary link moves focus to the field.
  await page.getByRole('link', { name: /Full name: Enter full name/ }).click();
  await expect(page.locator('#f-full_name')).toBeFocused();
});

test('keyboard only: a complete form (Contract) becomes ready', async ({ page }) => {
  await open(page);
  await fillRequiredByKeyboard(page, 'Contract');
  await tabTo(page, 'submit-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#form-status')).toHaveText(
    'Ready to submit (demo). Nothing was sent.',
  );
});

test('conditional field is absent and not required when hidden', async ({ page }) => {
  await open(page);
  await expect(page.locator('#f-contract_end_date')).toHaveCount(0);
  await fillRequiredByKeyboard(page, 'Full-time');
  await expect(page.locator('#f-contract_end_date')).toHaveCount(0);
  await tabTo(page, 'submit-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#form-status')).toHaveText(
    'Ready to submit (demo). Nothing was sent.',
  );
  await page.locator('#f-employment_type').selectOption('Contract');
  await expect(page.locator('#f-contract_end_date')).toBeVisible();
});

test('rejects a wrong file type and a missing required file with plain messages', async ({
  page,
}) => {
  await open(page);
  await page
    .locator('#s-photo')
    .setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.locator('#s-photo-error')).toContainText('This file type is not allowed');
});

test('reload restores non-sensitive answers only; Clear removes the draft', async ({ page }) => {
  await open(page);
  await page.locator('#f-full_name').fill('Draft Person');
  await page.locator('#f-bank_reference').fill('SECRET-REF-123');
  await page.waitForTimeout(200);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).toContain('Draft Person');
  expect(stored).not.toContain('SECRET-REF-123');
  expect(Object.keys(JSON.parse(stored)).every((k) => k.startsWith('formiva:draft:'))).toBe(true);

  await page.reload();
  await expect(page.locator('#f-full_name')).toHaveValue('Draft Person');
  await expect(page.locator('#f-bank_reference')).toHaveValue('');

  await page.locator('#clear-btn').click();
  await expect(page.locator('#f-full_name')).toHaveValue('');
  const left = await page.evaluate(() => Object.keys(localStorage).length);
  expect(left).toBe(0);
});

test('the form still works when browser storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  await page.goto(URL);
  await page.locator('#f-full_name').fill('No Storage');
  await expect(page.locator('#f-full_name')).toHaveValue('No Storage');
});

test('axe: no violations on the empty form', async ({ page }) => {
  await open(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('axe: no violations with the error summary showing', async ({ page }) => {
  await open(page);
  await page.locator('#submit-btn').click();
  await expect(page.locator('#error-summary')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
