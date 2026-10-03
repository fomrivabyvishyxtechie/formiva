# Formiva CaseFlow — Project Document Index

This folder is the active Formiva production workspace.

## Rules

- `CLAUDE.md`, `.claude/`, `scripts/.claude/`, Skills, and related control files are preserved and are not modified by the document merge.
- `DESIGN.md` remains the governing UI/UX specification.
- The documents below are the working project knowledge base; source documents are retained under `docs/source-package/originals/`.
- Generated Markdown/DOCX files are production-facing documentation without branding overlays.
- Examples and fixtures must use synthetic or redacted data only.

## Single-point working documents

- [Master Build Roadmap](roadmap/Formiva_Master_Build_Roadmap.md)
- [API Contract v1.1](api/Formiva_API_Contract_v1.1.md)
- [Phase 0 Kit](product/Formiva_Phase_0_Kit.md)
- [Decision Index](decisions/Formiva_Decision_Index.md)
- [ADR-17: Parallel demo build](decisions/ADR-17-parallel-build-before-discovery.md)
- [Security Boundary](security/Formiva_Security_Boundary.md)
- [Assumptions](product/Formiva_Assumptions.md)

## Source package

Original Review Register, PRD, Technical Documentation, Coding Plan, Database Plan, SOP, POC, Business Plan, dashboard, and database package files are retained under `docs/source-package/` and `packages/db/`.

## Current implementation start

Begin with API Step 1 in the API Contract: minimal compiling Fastify scaffold, safe configuration validation, correlation IDs, RFC 9457 errors, `/healthz`, Zod contracts, and tests.

