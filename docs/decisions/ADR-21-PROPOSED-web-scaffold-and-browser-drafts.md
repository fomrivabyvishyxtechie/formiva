# ADR 21: Web Scaffold and Browser Drafts

Status: PROPOSED

## Context
We need to scaffold the `apps/web` application for the Formiva CaseFlow product and implement a browser-based draft mechanism for form submissions.

## Decision
- We will use Next.js App Router for `apps/web`.
- Form drafts will live only in the browser (localStorage) until a case exists.
- Sensitive fields will never be stored in the browser.
- Consequence: changing devices loses the draft.
- Alternatives considered: server-side drafts (rejected because it requires a token/case from Phase 3.2, which we don't have yet).

## Consequences
- Fast delivery of the initial web app.
- Simple, privacy-preserving draft handling for initial release.
- Users must understand that drafts are not synced across devices.
