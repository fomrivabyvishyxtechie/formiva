# Engineering Documentation

This repository contains the Formiva CaseFlow production workspace.

## Single-point project documents

- [Formiva document index](Formiva_Document_Index.md)
- [Master build roadmap](roadmap/Formiva_Master_Build_Roadmap.md)
- [API Contract v1.1](api/Formiva_API_Contract_v1.1.md)
- [Phase 0 kit](product/Formiva_Phase_0_Kit.md)
- [Decision index](decisions/Formiva_Decision_Index.md)
- [Security boundary](security/Formiva_Security_Boundary.md)

## Documentation structure

- `architecture/` — architecture and subsystem documents
- `api/` — REST/OpenAPI contracts and integration documentation
- `database/` — database documentation; implementation SQL is under `packages/db/`
- `infrastructure/` — deployment, networking, and CI/CD
- `security/` — security architecture and threat controls
- `runbooks/` — operations procedures
- `decisions/` — ADRs and decision index
- `roadmap/` — phase-by-phase build plan
- `product/` — Phase 0 kit, assumptions, and product planning
- `source-package/originals/` — retained authoritative source documents

`CLAUDE.md`, `.claude/`, `scripts/.claude/`, Skills, and `DESIGN.md` are preserved project-control/design files and are not replaced by this documentation merge.
