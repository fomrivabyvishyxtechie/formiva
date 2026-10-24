# Prompt 3.1b evidence: apps/web scaffold and form renderer

Date: 2026-10-24. Branch: phase-3-web-v2 (from main after 3.1a was merged). Owner: founder. Status: DRAFT for review.

## Changed
- `apps/web`: Next.js 15.5.28 + React 19.1.4 (exact pins), strict TypeScript, workspace package `@formiva/web`.
- `FormRenderer` (outer component has no hooks; inner component holds all hooks): labels, required marked in text, `aria-describedby`/`aria-invalid`,
  all 11 field types, document slots (selection and checking only, no upload), conditional fields (`depends_on`/`equals`, transitive),
  plain-language errors, error summary that takes focus, "Continue" shows "Ready to submit (demo)" and sends nothing.
- Browser drafts (`localStorage`, key `formiva:draft:<schema hash>`): sensitive/highly_sensitive fields, file and signature inputs are never stored;
  empty draft removes the key; blocked storage does not break the form; "Clear saved answers".
- `/dev/form-demo` (synthetic fixture), 404 in a production build. Public `/f/[token]` is NOT built (Prompt 3.2).
- Security headers (nosniff, no-referrer, X-Frame-Options, CSP with `frame-ancestors 'none'`, no `unsafe-eval`).
- Root: `.gitignore`, `.prettierignore`, format globs now include tsx/css/mjs in apps; CI installs Chromium and runs the web e2e suite.
- `packages/contracts`, `apps/api`, `packages/db`: untouched.

## Verified (real runs on a clean Linux copy with PostgreSQL 16, not on the founder's Windows machine)
- `pnpm run verify`: exit 0. Contracts 19 passed, web unit 10 passed, API 40 passed, DB 105 checks, config 2, observability 3. Build includes `next build`.
- `pnpm --filter @formiva/web run e2e`: 20 passed (2 viewports x 9 UI tests + 2 production-build tests).
  UI tests: render and no horizontal scroll; keyboard-only empty submit focuses the error summary and its links focus fields; keyboard-only complete form;
  conditional field absent/not required when hidden; wrong file type rejected; reload restores only non-sensitive answers and Clear removes the draft;
  works with blocked storage; axe zero violations (empty and error states). Viewports: 375x812 and 1280x800.
- A real bug was found by the e2e suite and fixed: document-slot errors were never shown because the "touched" key did not match.

## Not done / limits
- DESIGN.md is not in the repository, so there is no visual design. Layout CSS only (black/white, no shadows, gradients, animation).
- Select options are read from `validation.options` because the 3.1a contract has no `options` property (see ADR-21 open items).
- `accessibility_label` and `validation` rules other than `options` are not used yet.
- Submit does nothing server-side; uploads are not implemented (3.3); resume across devices does not exist.
- CSP needs `script-src 'unsafe-inline'` (Next.js inline bootstrap). Nonce-based CSP is a follow-up.
- Screen-reader testing with a real assistive tool was not done; axe covers automated rules only.
- CI for this branch has not run yet.
