Use the Formiva Master Build Roadmap Master Context Block. Execute only Phase 3, Prompt 3.1, step 3.1a. Branch: phase-3-intake.

FIRST (no code yet): restate the task, list every file you will create or modify, and name anything that conflicts with ADRs, migrations 001-014 or DESIGN.md. Read docs/roadmap/phase-3-plan.md, packages/db/migrations/002_tenancy_forms.sql (form_templates, form_template_versions, form_fields) and 004 (case_documents.doc_class). Do not edit migrations. Do not create apps/web or any UI in this step.

BUILD in packages/contracts only:
1. A strict Zod schema for a versioned form definition, matching what form_template_versions.schema_json and form_fields can store: field_key, label, field_type (only the types allowed by the form_fields CHECK), required, sensitivity (only the allowed values), validation, optional conditional, position, plain-language error messages, and an accessibility label per field.
2. Document slots: each slot has a key, label, required flag, allowed MIME types, max size, and a doc_class limited to the values allowed by case_documents.doc_class. Caste, community and police classes must be impossible to express. A slot or field that would hold a full government ID number must be rejected; Aadhaar may only be a masked-copy slot.
3. A validator that returns machine-readable errors (not only throws): duplicate field_key, conditional rule pointing at a missing field, unknown field type, empty label, oversize definition, too many fields, slot with disallowed class.
4. A canonical-JSON function and sha256 of a published definition that produces the 32-byte value stored in schema_sha256. Same input always gives the same hash; any change gives a different hash. A helper that reports whether a definition is publishable (valid, hash present).
5. Unit tests for all of the above, plus attack tests: prototype-pollution keys, huge input, unicode tricks in field_key, a definition containing a full 12-digit ID-looking value, and a slot with a prohibited class. Use synthetic values only.

CONSTRAINTS: smallest change; no new dependency except what packages/contracts already uses; no raw SQL; no secrets; export from packages/contracts/src/index.ts the way existing contracts are exported.

VERIFY: run `pnpm run verify` and `pnpm exec vitest run tests/security` with DATABASE_URL set to the local test database. Save the output to docs/evidence/phase-3/2026-10-18-prompt-3.1a-verify.txt.

REPORT in this format: Changed / Verified / Documentation updated / Security considerations / Remaining risks. List uncertainties plainly. Do not mark Prompt 3.1 complete: 3.1b (web renderer) is a separate step.
