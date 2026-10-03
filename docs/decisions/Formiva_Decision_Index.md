# Formiva Decisions

## Current ADR index

The source package contains ADR-01 through ADR-16. This workspace adds:

- **ADR-17 — Parallel demo build before completing discovery**: build the synthetic-only demo now; defer interviews, but do not waive the discovery gate before sensitive-pilot or production use.
- **ADR-18 — Fastify foundation and shared contract scaffold**: establish the minimal API runtime, configuration validation, and health/problem schemas required before tenant-aware work begins.

Read the individual record in `docs/decisions/` before changing sequencing, scope, infrastructure, data handling, or security boundaries.
