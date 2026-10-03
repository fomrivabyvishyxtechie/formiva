# ADR-18 — Fastify foundation and shared contract scaffold

- Date: 2026-10-03

## Status

Accepted

## Context

Phase 1.1 must create the smallest viable API foundation without adding database access, Clerk auth, tenancy logic, or other business domains. The project requires a Fastify runtime, TypeScript safety, environment validation, request/correlation IDs, and RFC 9457 problem payloads to support future API evolution while preserving security boundaries.

## Decision

We will use a minimal monorepo layout with dedicated workspace packages for configuration, contracts, and observability, and a Fastify application in `apps/api` that exposes only the safe `/healthz` endpoint and structured error handling.

The configuration package validates environment values using Zod with explicit defaults and rejects malformed settings early. Shared contracts describe the health response and RFC 9457 problem payload shape. Observability helpers generate or reuse request and correlation IDs and redact sensitive values before they are logged or serialized.

## Consequences

### Positive

- The API starts with a narrow, reviewable surface area.
- Shared schemas keep the health and error contract consistent across packages.
- Validation and redaction are centralized, improving security and debuggability.

### Negative

- The initial scaffold intentionally omits tenant-aware behavior and authentication flows, which will be implemented in later phases.
- Future API endpoints must adopt the same validation and RFC 9457 conventions to keep the contract consistent.
