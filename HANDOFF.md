# Formiva CaseFlow — Claude Handoff

**Repository:** `C:\MAIN-DEV-ALL\Formiva`  
**Product:** Formiva CaseFlow by VishyxTechie.in  
**Handoff date:** 2026-10-03  
**Handoff status:** Documentation and repository foundation prepared; application implementation is not yet complete.

> Read this file before starting Formiva work. It is a navigation and context document, not a replacement for the authoritative source documents. Do not claim functionality exists until code, tests, and evidence prove it.

---

## 1. Mission

Formiva is a multi-tenant SaaS that takes a form submission through:

1. Form intake and consent.
2. Safe document upload and quarantine.
3. AI-assisted document reading and evidence extraction.
4. Deterministic backend routing.
5. Human review and correction when required.
6. Human approval for sensitive or irreversible actions.
7. One audited external action.
8. Durable state, audit history, retry, recovery, retention, and operational evidence.

The first build target is a **synthetic-data MVP/demo**. It is not yet a production-sensitive-data system.

---

## 2. Working directory and protected areas

Use this directory as the active working directory:

```text
C:\MAIN-DEV-ALL\Formiva
```

Do not modify, replace, delete, or reorganize these areas unless the founder explicitly requests it:

```text
.claude\
.claude\skills\
scripts\.claude\
CLAUDE.md
INSTALL-SKILLS.md
DESIGN.md
```

`CLAUDE.md` defines the repository’s engineering operating loop. Follow it: inspect first, read relevant skills/memory, plan, make the smallest coherent change, test, review the diff, update documentation, record durable decisions, and report risks.

`DESIGN.md` is the governing UI/UX design specification. Before substantial UI work, read it and preserve its rules. Do not replace it with generic AI-generated UI patterns.

---

## 3. Current implementation status

### Completed foundation

- Repository scaffold exists.
- Production workspace is `C:\MAIN-DEV-ALL\Formiva`.
- Formiva master roadmap is present.
- API Contract v1.1 is present in Markdown and DOCX.
- Phase 0 kit is present.
- Decision index and ADR-17 are present.
- Security boundary and assumptions are present.
- Original project source documents are retained.
- Database schema, migrations 001–008, and SQL tests are present under `packages\db`.
- Existing Claude/Skills/project-control files were preserved.

### Not yet complete

- The application API is not yet implemented.
- The frontend is not yet implemented.
- The worker is not yet implemented.
- The AI Engine is not yet implemented.
- PostgreSQL has not been deployed as a verified production environment from this workspace.
- OCI/Cloudflare/Netlify/provider deployment evidence is not complete.
- No customer-sensitive pilot is authorized.
- No real ID numbers, customer documents, credentials, production dumps, or secrets may be used.

### Important status distinction

A document, route table, folder, schema, or prompt is not proof of implemented functionality. Report features as **planned** until implementation and tests exist.

---

## 4. Read these documents first

Read in this order for normal engineering work:

1. `CLAUDE.md`
2. `HANDOFF.md` — this file
3. `docs\Formiva_Document_Index.md`
4. `docs\roadmap\Formiva_Master_Build_Roadmap.md`
5. Relevant domain contract:
   - `docs\api\Formiva_API_Contract_v1.1.md`
   - `packages\db\formiva_schema_v2.1.sql`
   - `DESIGN.md` for UI work
   - `docs\security\Formiva_Security_Boundary.md` for security work
6. `docs\decisions\Formiva_Decision_Index.md`
7. Relevant ADR, source-package document, memory, and installed skill.

### Original source package

The original authoritative project files are retained under:

```text
docs\source-package\originals\
```

This includes the Review & Change Register, PRD, Technical Documentation, Coding Plan and Prompt Pack, Database Plan, SOP, POC, Business Plan, and project dashboard.

### Database source package

```text
packages\db\formiva_schema_v2.1.sql
packages\db\migrations\
packages\db\tests\
packages\db\README.source-package.md
```

The schema filename in the source package was `formiva_schema_v2_1_full.sql`; the active copied filename is `formiva_schema_v2.1.sql`.

---

## 5. Source-of-truth and conflict handling

For current Formiva architecture, schema, infrastructure, security, scope, API, and UI decisions, use the project authority order:

1. Review & Change Register and approved change decisions.
2. Current ADRs.
3. Actual implementation and tests.
4. Current database SQL/schema.
5. Technical Documentation.
6. `DESIGN.md` for UI/UX.
7. PRD.
8. Coding Plan/Roadmap.
9. SOP.
10. Business Plan.
11. POC/historical planning material.

The repository `CLAUDE.md` also defines an engineering hierarchy that prioritizes current source code/tests and current infrastructure/configuration. Treat this as an operational rule for describing what is actually implemented. If an approved project decision conflicts with code, do not silently choose: identify the conflict, state which project decision governs the intended architecture, and create/update an ADR or documentation note when changing implementation.

Never invent schema, APIs, infrastructure, provider terms, prices, quotas, legal conclusions, or product behavior.

---

## 6. Locked architecture decisions

### Infrastructure

- Two separate free-tier OCI accounts.
- VM1: PostgreSQL, API, worker, scheduler, ClamAV, and operational services.
- VM2: isolated AI Engine only.
- No third VM.
- Frontend on Netlify free tier under the current project decision.
- VM1/VM2 communication uses two independent Cloudflare Tunnels because the OCI accounts are separate.
- AI Engine hostname is restricted by Cloudflare Access service token/mTLS plus HMAC request signing.
- Verify current provider limits and terms before deployment or customer promises.

### Database and queue

- PostgreSQL is the durable source of truth.
- PostgreSQL dispatches jobs using claim/lease patterns with `FOR UPDATE SKIP LOCKED`.
- Valkey is optional and must not become a second source of job truth.
- SQL-first migrations; Drizzle may provide typed access.
- Tenant isolation uses application authorization, composite foreign keys, forced row-level security, and transaction-local context.
- No tenant context means zero tenant rows.
- Append-only evidence and audit tables cannot be updated/deleted through ordinary application privileges.
- State machines and safety invariants are enforced in the database as well as the application.

### AI

- AI Engine runs on VM2 and has no cloud credentials.
- The worker sends verified bytes/approved object references.
- AI reads one document and returns structured, evidence-linked suggestions.
- AI does not decide or authorize actions.
- Backend validates the response and recomputes the route deterministically.
- Model/OCR/engine versions, evidence, confidence, policy, and trace IDs are recorded.

### Government/identity documents

- Formiva reads and extracts; it does not claim to verify authenticity.
- Collection is opt-in per employer with a stated purpose.
- Masked Aadhaar copies only.
- Full ID numbers are never stored in clear text.
- Highly sensitive values use ciphertext plus key reference and masked preview.
- Caste, community, and police documents are not collected by default and are never sent to AI extraction.

### UI/UX

Follow `DESIGN.md` exactly:

- Flat bordered panels.
- Teal reserved for AI-assisted signifiers.
- No glassmorphism.
- No decorative gradients.
- No sparkle icons.
- No generic hover-scale effects.
- Motion must remain within the defined ceiling.
- Preserve accessibility and mobile-first behavior.

---

## 7. ADR-17 and product status

ADR-17 is accepted. The founder chose to build a synthetic demo before approaching companies.

This changes sequencing, not safety:

- Technical build may proceed now.
- Interviews and outreach are deferred, not waived.
- The product remains synthetic/redacted-data-only until the sensitive-pilot gate.
- The approved business-validation criteria remain 8 of 15 firms naming the same problem and 3 firms willing to pilot.
- A working demo is not customer validation, compliance, production readiness, or authorization to process sensitive customer data.
- Any new material scope, architecture, provider, security, or data decision receives the next ADR number.

---

## 8. Security rules

Never use or commit:

- Real personal data.
- Real ID numbers.
- Real customer documents.
- Production database dumps.
- Credentials, API keys, tokens, private keys, or SSH keys.
- Real provider secrets.

Required controls:

- Synthetic fixtures must be visibly synthetic and invalid for government identifiers.
- Secrets are handled only through approved local/deployment secret handling.
- AI output is untrusted data.
- Sensitive/irreversible actions require deterministic policy and human approval.
- No raw sensitive values in logs, analytics, URLs, ordinary audit payloads, prompts, screenshots, or OpenAPI examples.
- Files enter quarantine before scanning and are not readable by application flow until clean.
- Signed viewing links are short-lived, restrictive, tenant-scoped, and watermarked where required.
- Unknown external outcomes are never blindly retried.
- Cross-tenant negative tests are mandatory.
- Do not claim DPDP, GDPR, SOC 2, ISO 27001, HIPAA, or PCI compliance as a blanket fact from this architecture.

Before the first code merge, require secret scan, `.gitignore` coverage, synthetic fixture validation, tenant-isolation test plan, and a test proving malformed/timeout AI output cannot become approval.

---

## 9. API context

The single working API reference is:

```text
docs\api\Formiva_API_Contract_v1.1.md
docs\api\Formiva_API_Contract_v1.1.docx
```

API implementation locations:

```text
apps\api
packages\contracts
packages\config
packages\observability
```

API baseline:

- REST/OpenAPI 3.1.
- Fastify, TypeScript, Zod.
- `/public/v1` for signed respondent-token flows.
- `/v1` for authenticated workspace flows.
- `/internal/v1` for internal service boundaries.
- `/healthz` for safe health response.
- Protected `/metrics` for operational metrics.
- Clerk JWT verification against JWKS.
- Workspace selector is only a selector; membership establishes authorization.
- RFC 9457 `application/problem+json` errors.
- Correlation IDs across API, worker, AI, integration, and audit.
- `Idempotency-Key` for create-work POSTs.
- `404` for cross-tenant identifiers to avoid existence leaks.
- `409` for state conflicts.
- `429` with `Retry-After` for rate limits.

Public flow:

```text
GET  /public/v1/forms/{respondent_token}
PUT  /public/v1/forms/{respondent_token}/draft
POST /public/v1/forms/{respondent_token}/upload-requests
POST /public/v1/forms/{respondent_token}/submit
```

Authenticated domains:

```text
workspaces and members
forms and immutable versions
cases and timelines
documents and signed viewing links
review tasks and human corrections
approval rounds and decisions
workflow drafts, lint, dry-run, publish, rollback
integrations and safe-mode controls
audit, document policy, deletion/legal hold
health, readiness, and metrics
```

Internal AI endpoint:

```text
POST /v1/ai/jobs
```

The backend owns final routing. The AI `routing_recommendation` is advisory only.

---

## 10. Roadmap and phase gates

The master roadmap is:

```text
docs\roadmap\Formiva_Master_Build_Roadmap.md
docs\roadmap\Formiva_Master_Build_Roadmap.docx
```

### Current next step

**Phase 1, API Step 1:** create the minimal compiling API scaffold.

Required first implementation scope:

- `apps/api` Fastify entry point.
- `packages/contracts` entry point.
- `packages/config` environment schema.
- `packages/observability` correlation/redaction helpers.
- Strict TypeScript and scripts.
- Safe environment validation.
- `GET /healthz`.
- RFC 9457 problem response helper.
- Correlation/request IDs.
- Unit tests.
- `make verify` or the repository’s equivalent verification command.

Do not implement Clerk, database routes, forms, uploads, AI, workflows, integrations, billing, or UI in the first prompt.

### Phase sequence

1. Phase 0 — discovery, synthetic corpus, benchmark and decision preparation.
2. Phase 1 — foundations and infrastructure.
3. Phase 2 — database and tenant authorization.
4. Phase 3 — intake, forms, uploads and file safety.
5. Phase 4 — review queue, approvals and timeline.
6. Phase 5 — workers, durable jobs and Resend adapter.
7. Phase 6 — isolated AI Engine on VM2.
8. Phase 7 — deterministic routing and complete synthetic loop.
9. Phase 8 — visual workflow editor.
10. Phase 9 — integrations.
11. Phase 10 — hardening and sensitive-pilot gate.
12. Paid pilot operating gate.
13. Phase 11 — measure and decide.
14. Final release gate.

Do not skip phase exit tests. A live online demo after the synthetic loop is not a sensitive-data pilot.

---

## 11. Required engineering workflow for Claude

For every non-trivial change:

1. Read `CLAUDE.md` and this handoff.
2. Inspect the relevant code, docs, SQL, ADRs, memory, and installed skill.
3. State a brief plan before editing.
4. Make the smallest coherent change.
5. Run relevant unit/integration/E2E, lint, typecheck, build, and security checks.
6. Review the diff for regressions and document drift.
7. Update the relevant API/database/infrastructure/runbook document.
8. Add an ADR for durable architectural decisions.
9. Add a dated update under `docs\updates\` for meaningful work.
10. Update `docs\changelog\CHANGELOG.md` for meaningful user/developer-visible changes.
11. Never commit unless explicitly requested.
12. Report:
    - Changed
    - Verified
    - Documentation updated
    - Security considerations
    - Remaining risks/follow-ups

Do not reset, clean, checkout, delete, or rewrite unrelated user work.

---

## 12. First coding prompt

Use the project context above and paste this prompt into the coding agent:

```text
Use HANDOFF.md, CLAUDE.md, docs/Formiva_Document_Index.md, and docs/api/Formiva_API_Contract_v1.1.md as context. Implement only Phase 1 API Step 1: the minimal compiling Fastify API and shared contract scaffold.

Before coding, list every file you will create or modify. Create apps/api, packages/contracts, packages/config, and packages/observability entry points. Add strict TypeScript, Fastify, Zod, safe environment validation, correlation/request IDs, RFC 9457 problem responses, and GET /healthz. Do not implement Clerk, database access, workspace routes, forms, uploads, AI, workflows, integrations, billing, or UI. Do not add providers, servers, secrets, or real data.

Add tests for /healthz, missing configuration, safe error serialization, correlation IDs, and secret redaction. Use synthetic values only. Run the repository verification command and report changed files, tests, evidence path, uncertainties, and any documentation drift. Do not modify CLAUDE.md, .claude, scripts/.claude, Skills, INSTALL-SKILLS.md, or DESIGN.md.
```

Do not proceed to the next API step until this first step passes on a clean clone and the result is documented.

---

## 13. Handoff completion checklist

Before considering the repository ready for continued work, Claude must verify:

- [ ] Working directory is `C:\MAIN-DEV-ALL\Formiva`.
- [ ] `HANDOFF.md` and `CLAUDE.md` have been read.
- [ ] Relevant `.claude` skill and memory have been read.
- [ ] `docs\Formiva_Document_Index.md` has been read.
- [ ] Relevant source authority and ADRs have been checked.
- [ ] No real personal data or secrets are present.
- [ ] No cross-tenant behavior is added without negative tests.
- [ ] No endpoint is claimed live without code/tests/evidence.
- [ ] No `.claude`, Skills, `CLAUDE.md`, `INSTALL-SKILLS.md`, or `DESIGN.md` file is changed unintentionally.
- [ ] API/database/infrastructure documentation is updated with meaningful code changes.
- [ ] Security, remaining risks, and follow-up gates are reported.

---

## 14. Current risks and open work

- Customer demand is not yet validated because discovery is deferred under ADR-17.
- Provider limits, pricing, regions, and terms require verification before promises.
- The actual database test count must be reconciled with source documents and dashboard.
- The Review Register and dashboard should reference ADR-17 consistently.
- API, frontend, worker, AI Engine, deployment, monitoring, backup/restore, and incident evidence remain to be implemented and tested.
- The sensitive-pilot gate remains closed until discovery, security, privacy, operational, and benchmark evidence passes.

**End of handoff.**
