# ADR-21: Web scaffold and browser-only drafts

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-24
Phase: 3 (Prompt 3.1b)
Note: ADR-20 is reserved for the solo-founder risk acceptance.

## Decision
1. `apps/web` is a Next.js App Router application (Next 15, React 19), exact-pinned, a pnpm workspace package `@formiva/web`.
2. Until a case exists (Prompt 3.2 issues the respondent token and case), a respondent's draft lives only in their own
   browser (`localStorage`, key `formiva:draft:<schema hash>`).
3. Fields marked `sensitive` or `highly_sensitive`, and all file and signature inputs, are never written to browser storage.
4. The renderer validates the form definition with `@formiva/contracts` before showing anything and shows nothing if it is invalid.
5. The only page in this prompt is the dev-only `/dev/form-demo` (returns 404 in a production build). `/f/[token]` is Prompt 3.2.

## Reasons
- No server draft can be stored before a token or case exists (schema: `respondent_tokens`, `cases`).
- Keeping sensitive answers out of the browser avoids leaving personal data on shared or borrowed devices.

## Consequences
- A respondent who changes device or clears browser data loses the draft. Cross-device resume arrives with server drafts in 3.2.
- Any answer typed into a sensitive field is lost on reload. The form says "Not saved on this device".
- Production CSP currently needs `script-src 'unsafe-inline'` because Next.js emits inline bootstrap scripts.
  A nonce-based CSP is a follow-up. `'unsafe-eval'` is not allowed.

## Alternatives considered
- Server drafts now: needs a token and case that do not exist yet (rejected for 3.1b).
- Storing everything in the browser: rejected (sensitive data on shared devices).

## Open items
- DESIGN.md is not in the repository; visual design is deliberately minimal until it is supplied.
- The contract has no `options` property for select fields; the renderer reads `validation.options` (string array). Decide
  whether to add a typed `options` field to the contract (would be a change to 3.1a contracts, needs its own decision).
