# ADR-27: Government Documents Policy in the build (Prompt 3.5)

Status: PROPOSED (the founder accepts or rejects; the agent must not set ACCEPTED)
Date: 2026-11-01
Phase: 3 (Prompt 3.5). Builds on ADR-14 and migration 007.

## Decision
1. Document types come from a fixed catalog in `@formiva/contracts` (`DOC_SUBTYPES`, 19 types). A test compares it with the database table `document_subtypes`. A form slot may name a `doc_subtype`; its `doc_class` must match.
2. A government-issued type is shown and accepted only if the workspace has a policy row that is not `not_collected`. No row means not collected (fail closed). Other types are allowed unless a row says `not_collected`.
3. Aadhaar: the slot label must say "masked", the policy must require a masked copy, and the upload request must send `masked_copy_confirmed: true` (else 422 `masked_copy_required`). Full Aadhaar is never requested.
4. Caste/community certificate and police verification are NOT in the catalog, so a form cannot ask for them and the policy API cannot switch them on (founder decision, "always reject for now"). If one is ever present in the database it never gets an AI job (`NO_AI_SUBTYPES`).
5. Uploads are filed with the catalog's default sensitivity (highly sensitive for PAN/Aadhaar etc.). The database trigger from migration 007 remains the last line of defence.
6. Typed ID numbers in forms stay refused (Technical Documentation: identity comes through documents). Highly sensitive VALUES (for example AI-extracted numbers, later) are stored encrypted by `@formiva/crypto`: AES-256-GCM, a random data key per value, wrapped by a per-workspace key derived (HKDF-SHA256) from a master key, bound to workspace/case/field/revision, last four digits kept for display.
7. The master key comes from a `KeyProvider` interface. Only an in-memory provider exists. Real custody (OCI Vault or SOPS with age) is open decision D-4 and nothing reads a key from the environment yet.
8. Admin is API only: `GET /v1/document-policies` (case.read) and `PUT /v1/document-policies/:doc_subtype` (workspace.manage, audited as `document_policy.updated`). The list shows every catalog type, with "not collected" for types without a row, so no default seeding is needed. No admin screen until Phase 4.

## Deviations to reconcile
- Technical Documentation 7.5 describes per-workspace data keys wrapped by a master key. No key table exists, so the wrapped data key is stored inside each ciphertext blob. Rotation = re-wrap blobs (`rewrapValue`).
- ADR-14 / migration 007 allow an employer to opt in to caste/police documents; this build is stricter on purpose. The database capability is untouched.
- Roadmap Prompt 3.5 mentions an admin screen; deferred to Phase 4.

## Known limits
- The encryption helper is not called by any route yet (nothing produces extracted values until the AI engine exists).
- Reveal of sensitive values (permission, watermark, audit) is not built.
- Retention (`retain_days`) is stored and applied to documents by the trigger, but no job deletes expired files.
- Legal sufficiency of purposes and retention is a legal caveat for counsel (decision D-6); no legal conclusion is made here.
