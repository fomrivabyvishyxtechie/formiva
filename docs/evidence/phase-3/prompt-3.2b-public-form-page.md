# Evidence: Prompt 3.2b public form page

Built by Claude (chat session), not by the coding agent. Synthetic data only.

## Changed
- `apps/web/src/app/f/[token]/page.tsx`, `components/PublicForm.tsx` (loads the form, saves drafts, handles 404/409/429).
- `apps/web/src/app/api/public/forms/[token]/route.ts` and `.../draft/route.ts` plus `lib/api-proxy.ts` (server-side forwarding, ADR-23).
- `FormRenderer` gets an optional `server` prop (consent checkbox, "Save draft", file/signature/highly sensitive fields withheld). Without the prop it behaves as before (the dev demo is unchanged).
- `form-logic.ts`: `serverSavable`, `toApiValues`, `fromApiValues`.
- Tests: 3 + 5 new unit tests, 4 new Playwright tests (mobile 375 and desktop 1280, axe included).

## Verified (sandbox)
- `pnpm run verify` exit 0; `tests/security` 30 pass; Playwright 28 pass (24 dev + production-build).
- The browser tests mock the proxy responses; the proxy is unit-tested with a mocked `fetch`.

## Not verified
- No end-to-end run of web + real API + database together.
- Netlify deployment of route handlers.
- Privacy notice text is not shown (only its version).

## Needs setting
- `API_BASE_URL` in the web environment (for example `http://127.0.0.1:3000` locally).
