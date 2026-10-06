# Formiva Decisions

## Current ADR index

The source package contains ADR-01 through ADR-16. This workspace adds:

- **ADR-17 — Parallel demo build before completing discovery**: build the synthetic-only demo now; defer interviews, but do not waive the discovery gate before sensitive-pilot or production use.
- **ADR-18 — Fastify foundation and shared contract scaffold**: establish the minimal API runtime, configuration validation, and health/problem schemas required before tenant-aware work begins.
- **ADR-19 — Workspace bootstrap and invitation lifecycle**: owner-approved design for database-owned idempotent workspace bootstrap and verified-email-bound hashed invitations; implementation is blocked pending security and technical reviewer approval.

Read the individual record in `docs/decisions/` before changing sequencing, scope, infrastructure, data handling, or security boundaries.
