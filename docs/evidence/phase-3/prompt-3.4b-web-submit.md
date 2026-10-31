# Evidence: Prompt 3.4b web submit button and confirmation page

Built by Claude (chat session). Synthetic data only. The browser tests mock the API; the API itself is covered by `tests/security/public-submit.test.ts` (3.4).

## Changed

- `apps/web/src/app/api/public/forms/[token]/submit/route.ts` (new) and `lib/api-proxy.ts` (`/submit` suffix): the browser still talks only to its own site (ADR-23).
- `PublicForm.tsx`: submit call with one idempotency key per page visit (a retry repeats the same key), plain-language messages for 409/422/429/503/404, "Form submitted" page, and a link that is already submitted shows that page instead of the form. Missing items from the API are shown by label, not by field key.
- `FormRenderer.tsx`: "Submit form" button (checks answers, saves the draft, then submits). Fix for a lost click: emptying a required field and pressing a button moved focus, the field's error line pushed the buttons down mid-click, and the click did nothing. Buttons no longer take focus from the field on mouse press.
- Tests: 5 new browser tests in `public-form.spec.ts` (one is the lost-click regression, confirmed failing before the fix), 1 proxy unit test.

## Verified (sandbox)

- Format, lint, typecheck, build clean. Web unit 19. Browser tests 36 (desktop 1280 and phone 375, includes axe on the confirmation page and the production-build header checks).
- Screenshots of the form, the error list and the confirmation page at both widths were checked by eye.

## Not verified

- Not run against a real API in a browser (mocked API only). Not tried on a real phone or with a screen reader.
- No file upload control: a form with a required file cannot be completed here. Needs a real R2 bucket with CORS for the web address (decision still open) and ClamAV.
- The submit key lives in page memory: after a full page reload a new key is used. That is safe (a submitted case just returns the original result).
