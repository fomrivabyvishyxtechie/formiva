# Engineering Lessons

Record reusable lessons discovered while working on the project.

Format:

## YYYY-MM-DD — Short title
- Context:
- What happened:
- Root cause:
- Fix:
- Prevention:

## 2026-10-04 — Clerk subjects are not tenant user IDs
- Context: API authentication must map a verified Clerk subject to Formiva's UUID-backed user and membership records.
- What happened: The existing RLS policies correctly hide the identity projection until a workspace has been selected.
- Root cause: A Clerk `sub` is an external identity key, not `users.id`.
- Fix: Resolve eligible workspace IDs with `ops.workspaces_for_user`, resolve the internal user UUID under `withTenant`, and recheck active membership and permissions inside the callback transaction.
- Prevention: Never set PostgreSQL tenant context from a client-supplied workspace or external identity value.

## 2026-10-04 — Auth test bypass requires explicit opt-in
- Context: API tests may run without Clerk credentials.
- What happened: Missing identity-provider configuration must not be interpreted as permission to skip authentication.
- Root cause: A configuration gap and an intentional synthetic-auth test mode are separate states.
- Fix: Allow the bypass only when the effective environment is `test` and the caller explicitly enables `testMode`; fail startup for missing configuration elsewhere.
- Prevention: Test auth configuration behavior for both explicit and implicit test-mode requests.
