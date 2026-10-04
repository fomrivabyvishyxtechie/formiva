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
