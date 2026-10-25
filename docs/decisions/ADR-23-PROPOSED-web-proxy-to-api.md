# ADR-23: The web app proxies public form calls to the API

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-10-25
Phase: 3 (Prompt 3.2b)

## Decision
1. The browser calls only its own site: `/api/public/forms/<token>` and `/api/public/forms/<token>/draft` (Next.js route handlers).
2. Those handlers forward to `${API_BASE_URL}/public/v1/forms/...` on the server. `API_BASE_URL` is a server-only variable (no `NEXT_PUBLIC_`).
3. The handler rejects a token that is not 64 hex characters without calling the API, passes on only `x-forwarded-for`, a new `x-correlation-id` and the JSON body, caps the body at 256 KB and times out after 10 s. Cookies and authorization headers are never forwarded.
4. No CORS is added to the API. The CSP stays `connect-src 'self'`.
5. The page `/f/[token]` saves a server draft only (no browser copy). Files, signatures and highly sensitive fields are not shown until 3.3 and 3.5.

## Reasons
- The API address stays out of the browser, and no cross-origin rules need to be opened on a service that handles personal data.
- One place to add limits and logging later.

## Consequences
- Every save passes through the web host, so the host's own limits and logs apply. The token is in the URL path, so web host access logs can contain it. Check the host's log settings before real use.
- The API sees the web server's address unless the host sets `x-forwarded-for`; rate limits and the consent IP hash depend on it.
- Next.js route handlers on Netlify's free tier are not tested here (vendor behaviour unverified).
- The privacy notice text is not stored anywhere yet; the page shows only the notice version. Needs a decision.
