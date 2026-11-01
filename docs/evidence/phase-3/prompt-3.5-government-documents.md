# Evidence: Prompt 3.5 Government Documents Policy

Built by Claude (chat session). Synthetic data only.

## Changed
- Contracts: `DOC_SUBTYPES` catalog, `doc_subtype` on slots, form-definition rules (Aadhaar slot must say masked; class must match type), policy API schemas.
- API: slot filtering and policy annotation on the public form; upload route enforces policy and masked-copy confirmation and files sensitivity from the catalog; submit ignores uncollected required slots and creates no AI job for special-category types; new `routes/document-policies.ts`; `services/sensitive-values.ts`.
- New package `packages/crypto` (envelope encryption, key-provider interface, masked preview). `pnpm-lock.yaml` and `apps/api/package.json` updated.
- Tests: `tests/security/government-documents.test.ts` (10), a policy-API test in `tenant-isolation.test.ts`, owner role fixture gets `workspace.manage`, two new routes in the coverage table, `packages/crypto/test` (8).
- ADR-27 (PROPOSED), decision index, API contract note.

## Verified (sandbox, PostgreSQL 16)
- Format, lint, typecheck, build clean; package unit tests pass (crypto 8, contracts 19, API 55, web 19 and others); security suite 70 pass, including the generated cross-tenant cases for the two new routes.
- No policy: government types not shown and uploads 422. Switched off: 422. Aadhaar needs confirmed masked copy. Catalog matches the database. Caste/police cannot be expressed or enabled. Encrypted value: no plaintext in the row, round trip works.
- Policy API: viewer gets 403 before body validation; owner can set; audit row written; other workspace unaffected.

## Not verified
- Web browser end-to-end tests were not re-run (no web change; CI runs them). No web upload control yet.
- Real storage, scanner, key custody (D-4). The encryption helper is not wired to a route. Legal sufficiency of purposes/retention.
