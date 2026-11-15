# ADR-30: How staff sign in to the web console (PROPOSED)

Status: Accepted. Written by the agent. Blocks Prompt 4.3 (reviewer and approver console) until the founder accepts or changes it.
Date: 2026-11-15
Phase: 4

## Why
The API already trusts only Clerk-issued tokens (ADR-19 and the Phase 2 auth work). The web app (`apps/web`) has no staff sign-in: it has only the respondent form. No existing document says how a staff browser session obtains a token or where it is kept. The console cannot be built without this, and a shortcut (a dev-only login) must not ship as the real thing.

## Proposed decision
1. Use Clerk's Next.js integration for staff sign-in only. Respondent pages stay unauthenticated (ADR-23 unchanged).
2. The browser never holds an API token. Staff pages call this site's own server-side route handlers (`/api/staff/...`); a handler reads the Clerk session on the server and calls the API with the session token, forwarding `X-Correlation-Id`.
3. The API stays the only place that decides permissions. The web layer hides buttons for usability only.
4. The staff routes get their own Content-Security-Policy entry; no new external script origin beyond Clerk's documented ones (vendor claim: to be checked against Clerk's current docs at build time).
5. Sensitive reveal responses are never cached (`no-store`, already set by the API) and are shown only in component state, never in the URL or local storage.

## Alternatives considered
- Token held in browser JS calling the API directly: simpler, but widens token theft exposure and needs CORS for the API.
- A dev-only login: not acceptable for production; allowed only as a clearly labelled test harness if the founder asks.

## Consequences
- Needs the Clerk publishable and secret keys in the web environment (the earlier exposed keys must be rotated first).
- 4.3 can start only after acceptance; the Phase 4 APIs and their tests do not depend on it.
