# Formiva CaseFlow — Master Build Roadmap

## Single source of working instructions for the founder and AI coding tools

**Project:** Formiva CaseFlow by VishyxTechie.in  
**Document type:** unified implementation, security, operations, and release roadmap  
**Prepared:** 03 October 2026  
**Current status:** planning and scaffold stage; application code is not yet implemented  
**Current build mode:** parallel demo build before completed customer discovery, approved by ADR-17  
**Launch wedge:** employee onboarding and document collection for Indian IT and professional-services firms with 10–100 employees

> This document consolidates the current Review & Change Register, ADR decisions, Technical Documentation, Database Plan, PRD, Coding Plan and Prompt Pack, Business Plan, POC, SOP, SQL package evidence, dashboard, and the current ADR-17 decision. It is intended to be the founder’s day-to-day build guide. It does not claim that any planned control is already implemented or that the product is compliant, production-ready, customer-validated, or safe for sensitive data.

---

## 0. How to use this document

Work from top to bottom. Do not jump to a later phase because a screen looks attractive or because an AI coding tool says a feature is easy.

For every step:

1. Read the phase goal and dependencies.
2. Copy the **Master Context Block** into the AI coding tool.
3. Copy only the relevant phase prompt.
4. Ask the tool to restate the task and list every file it will touch.
5. Reject the plan if it touches unrelated areas, introduces an unapproved provider, weakens a test, or changes an approved decision without an ADR.
6. Implement one small change on one branch.
7. Run the listed tests and the attack test.
8. Save evidence under `docs/evidence/phase-N/`.
9. Complete the phase decision record.
10. Proceed only after the exit test passes.

### 0.1 Current immediate position

The initial repository scaffold and the following control files have been created in this workspace:

- `README.md`
- `DECISIONS.md`
- `ASSUMPTIONS.md`
- `SECURITY.md`
- `.gitignore`
- `docs/decisions/ADR-17-parallel-build-before-discovery.md`
- the planned `apps`, `services`, `packages`, `infra`, `docs`, and `tests` directories

The **next implementation step** is Phase 1, Prompt 1.1: make the minimal monorepo compile, validate configuration, and pass `make verify` on a clean clone. Phase 0 evidence work must happen in parallel, starting with the synthetic corpus and pre-registered benchmark.

### 0.2 What ADR-17 changes

The original plan placed customer discovery before later implementation. The founder has now approved a demo-first approach. The product may be built with synthetic or redacted data while interviews are deferred.

ADR-17 does **not** waive the following:

- the discovery evidence remains required before a sensitive-data pilot or production claim;
- the 8-of-15 repeated-problem and 3-pilot criteria remain the approved business-validation criteria;
- no real documents, ID numbers, credentials, secrets, or production database dumps may enter the repository or AI prompts;
- Phase 8 and Phase 9 remain gated by the current paid-pilot/pilot-request decision unless a later ADR changes that gate;
- every material architecture, security, data, provider, or scope change receives a new numbered ADR.

---

# 1. Current governing decisions and conflict resolution

## 1.1 Authority order

When documents disagree, use this order:

1. Review & Change Register and approved change decisions.
2. Current ADRs.
3. Actual implementation/source code.
4. Current database SQL/schema.
5. Technical Documentation.
6. `DESIGN.md` for UI/UX.
7. PRD.
8. Coding Plan/Roadmap.
9. SOP.
10. Business Plan.
11. POC and historical planning material.

If the conflict cannot be resolved from that order, stop and create a decision record. Do not silently select the more convenient option.

## 1.2 Current baseline to build

| Area | Governing baseline |
|---|---|
| Frontend | Next.js/React frontend on **Netlify free tier**, subject to current free-tier verification. Vercel Hobby is not the commercial baseline. |
| Application host | VM1 on OCI: API, workers, scheduler, PostgreSQL, ClamAV, and backups. |
| AI host | VM2 on OCI: AI Engine only; CPU-only at the initial baseline; no cloud credentials and no general internet access. |
| OCI economics | Two separate free OCI accounts are the current approved arrangement; no paid infrastructure. Verify account terms, quotas, and availability in the console before deployment. |
| VM baseline | 2 OCPU / 12 GB / 200 GB per VM as the current project decision, subject to the Day-1 console check. Do not resize or upgrade without a new decision. |
| Database | PostgreSQL on VM1 is the durable source of truth and dispatches jobs with leases. Valkey is optional for cache, rate limits, and short-lived locks only. |
| Object storage | Cloudflare R2 with separate quarantine, documents, and backup boundaries; verify current pricing, location, terms, and limits before any customer promise. |
| Identity | Clerk for authentication and membership information; authentication is not tenant authorization. |
| Private access | Cloudflare Tunnel/Access and signed requests between VM1 and VM2 because separate accounts do not provide a free private VCN path. |
| Email | Resend adapter; one authorized synthetic notification in the POC. |
| Initial integrations | Signed webhooks, Google Sheets, and Razorpay in later Phase 9 work; generic connector boundary is required. |
| API | Fastify/Node.js/TypeScript REST with OpenAPI 3.1 and Zod validation. |
| AI Engine | Python 3.12, FastAPI, Pydantic v2, local model and OCR; AI output is advisory and untrusted. |
| Tenancy | Workspace-derived authorization, composite foreign keys, forced row-level security, and API permission checks. |
| Government documents | Read and extract only; never claim authenticity verification. Masked Aadhaar only; full ID numbers are ciphertext and never clear text. Caste, community, and police documents are not collected or sent to AI extraction. |
| UI style | Follow `DESIGN.md` exactly. Flat bordered panels, teal only for AI-assisted signifiers, no glassmorphism, decorative gradients, sparkle icons, generic hover-scale effects, or motion above the defined ceiling. `DESIGN.md` was not found in the uploaded package; UI work is blocked for final styling until it is supplied or its absence is recorded as a decision. |
| Source code | No raw `pool.query` outside `packages/db`; every route has schemas, tenant/permission middleware, audit behavior, and tests. |

## 1.3 Known document inconsistencies

These are not silently merged:

1. **Frontend and infrastructure economics:** some Business Plan, PRD, SOP, Coding Plan, and dashboard rows still contain Vercel Pro or Pay-As-You-Go references. The current Review Register and project instructions govern: Netlify free tier and no paid infrastructure. Those older references require documentation cleanup before deployment.
2. **OCI capacity:** older tables mention a 200 GB total or a 150 GB/50 GB split, while the current decision says two accounts and 200 GB per VM. The OCI console check remains mandatory; the observed quota, not a document estimate, decides whether the baseline is possible.
3. **Database test count:** the Database Plan reports 107 automated checks and a 12-session concurrency pass; the dashboard and SQL README refer to other counts such as 81 or 99. Use the actual SQL package test output as evidence and update the dashboard/documentation to one number.
4. **ADR count:** the source Register contains ADR-01 through ADR-16. ADR-17 is the current local decision for the parallel build and must be synchronized back into the Register and dashboard.
5. **Discovery gate sequencing:** the original roadmap expects discovery before later implementation. ADR-17 allows synthetic demo construction now, but discovery remains a gate before sensitive pilots and production claims.
6. **Sales Strategy interview table:** the uploaded package did not include a separate recoverable Stage 1 question table. Use the approved Diagnose fields and record that the exact source table is missing rather than inventing a verbatim source.
7. **Design specification:** `DESIGN.md` is named as the UI authority but was not found in the uploaded package. Do not invent a replacement design system without a decision.
8. **Phase naming:** the source corrected the old “11 phases” confusion. The approved technical phases are Phase 0 through Phase 11. This document adds a non-numbered **Final Release Gate** after Phase 11.

---

# 2. Master Context Block for every AI coding prompt

Copy this block first. Then append only one phase prompt from this document.

```text
You are helping build Formiva CaseFlow, a multi-tenant SaaS that turns an employee-onboarding form submission into a controlled case: validate -> AI reads documents -> deterministic routing -> human review or approval -> ONE authorised action -> immutable audit trail.

Founder: non-developer. Explain every change in plain English. Plan first, list files, implement one small change, run tests, and report files changed, commands, tests, evidence, and uncertainties.

Launch wedge: Indian IT and professional-services firms with 10–100 staff. Build the synthetic demo first under ADR-17, but do not use real customer data and do not claim customer validation or production readiness.

STACK: TypeScript strict, Node.js, pnpm workspaces. API: Fastify + Zod, REST/OpenAPI 3.1. PostgreSQL 16 with SQL-first numbered migrations, row-level security, append-only triggers, audit hash chain and durable job claim functions. Drizzle only for typed queries. Workers in Node. AI Engine: Python 3.12 + FastAPI + Pydantic v2. Web: Next.js App Router on Netlify free tier. Auth: Clerk. Files: Cloudflare R2. Email: Resend. VM1: API + workers + PostgreSQL + ClamAV + backups. VM2: AI Engine only, CPU-only initially, no cloud credentials, isolated network. Two separate free OCI accounts, no paid infrastructure. Everything must build for linux/arm64.

INVARIANTS:
1. Workspace scope comes from authenticated membership, never the request body.
2. Every database transaction sets transaction-local tenant context and uses withTenant(). No raw DB access outside packages/db.
3. App roles are non-superuser and do not have BYPASSRLS.
4. AI output is untrusted data; validate it and recompute routing in the backend.
5. Timeout, missing model, malformed output, low OCR quality, conflict, or uncalibrated score never becomes approval.
6. Sensitive or irreversible actions never auto-execute; complete approval is required.
7. One business effect per idempotency key. Unknown provider outcomes go to lookup or human review, never blind retry.
8. AI results, evidence, routing decisions, human corrections and audit events are append-only.
9. Highly sensitive values are ciphertext only and never logged. Aadhaar: masked copy only; only last four may be displayed.
10. No secret in code, logs, prompts, tests, fixtures, or database; store references only.
11. Never edit an applied migration; add a new numbered migration.
12. Fail closed when tenant, role, policy, safety, or configuration is unknown.
13. Government documents are read/extracted only, never authenticity-verified. Caste, community and police documents are not collected or sent to AI.
14. Files are untrusted until scanned. Quarantine is scanner-only.
15. Every connector supports validation, healthCheck, dryRun, execute, error classification, lookupStatus, redaction, safe mode, and idempotency.
16. Follow DESIGN.md when available; do not invent generic AI UI patterns.

SECURITY: no real documents, IDs, credentials, keys, tokens, production dumps, provider dashboards, or .env files. Use synthetic fixtures and .env.example placeholders.
```

---

# 3. Universal definition of done

A task is not done because the screen renders or the test is green once.

| Check | Required result |
|---|---|
| Scope | The change is limited to the approved task and files. |
| Tests | New behavior has normal tests and at least one attack/negative test. |
| Tenant safety | Wrong workspace, wrong role, missing auth, and foreign IDs are tested. |
| State safety | Illegal transitions, duplicate delivery, retry, unknown outcome, and restart behavior are tested where relevant. |
| Audit | Every state-changing operation creates a correlation-linked audit event. |
| Data handling | No sensitive values leak into logs, URLs, analytics, fixtures, or AI prompts. |
| Review | A technical reviewer reads Phases 2, 5, 6, 7, and 10 changes. |
| Evidence | Test output, screenshots, benchmark reports, and command output are saved in `docs/evidence/phase-N/`. |
| Decision | The phase record says Pass, Fail, or Restricted and records changed assumptions. |
| Release | The branch, checks, migration review, rollback note, and release tag are traceable. |

## 3.1 AI coding supervision loop

1. **Plan:** ask the tool to restate the problem and list files.
2. **Review plan:** reject unrelated files, new providers, new servers, or weakened controls.
3. **Implement:** one prompt, one branch, one small pull request.
4. **Verify:** run `make verify`, focused tests, and the phase attack test.
5. **Break it:** try wrong tenant, wrong role, malformed input, duplicate delivery, oversized/hostile file, timeout, or unknown provider outcome.
6. **Review:** inspect migrations, authorization, logs, errors, and data handling in plain English.
7. **Record:** save evidence and update `DECISIONS.md`, `ASSUMPTIONS.md`, and the phase record.

Never give an AI tool real customer data, real IDs, production dumps, `.env` files, private keys, tokens, passwords, SSH keys, or provider dashboards.

---

# 4. Repository structure

Create and keep this structure. Empty directories need a `.gitkeep` until they contain code.

```text
formiva/
  apps/
    web/                    Next.js public form, reviewer console, admin, editor
    api/                    Fastify API and authorization boundary
    worker/                 durable job runner, workflow, scheduler, integrations
  services/
    ai-engine/              Python FastAPI CPU-only AI service
  packages/
    db/                     SQL migrations, runner, Drizzle types, withTenant
    contracts/              Zod schemas, OpenAPI, AI contracts
    policy/                 pure deterministic routing function
    workflow/               workflow JSON schema, linter, dry-run engine
    crypto/                 encryption, HMAC signing, token hashing
    integrations/           adapter interface and provider adapters
    config/                 fail-fast environment validation
    observability/          redacting logger, correlation IDs, metrics
  infra/
    vm1/                    Compose for API, worker, DB, ClamAV, backup
    vm2/                    Compose for AI Engine and lightweight metrics
    cloudflared/            Tunnel and Access templates
    scripts/                hardening, backup, restore, rotation
  docs/
    architecture/ decisions/ runbooks/ evidence/ benchmarks/ security/
  tests/
    fixtures/               deterministic synthetic corpus
    e2e/ integration/ security/ ai-benchmark/ reliability/
  README.md
  DECISIONS.md
  ASSUMPTIONS.md
  SECURITY.md
  Makefile
```

---

# 5. Phase 0 — Discover and prepare, adapted for the demo-first decision

**Source timing:** weeks 1–2; the original roadmap allowed interviews in the background.  
**Current mode:** synthetic demo preparation and technical build may proceed in parallel under ADR-17.  
**Goal:** make the problem, corpus, routing policy, benchmark, and decision records explicit before AI or workflow behavior is trusted.

## 5.1 Phase 0 minute steps

### Step 0.1 — Confirm the decision boundary

- [x] Keep ADR-17 in `docs/decisions/`.
- [ ] Add ADR-17 to the Review & Change Register and dashboard.
- [ ] Mark customer discovery as **deferred**, not cancelled.
- [ ] Mark the sensitive-pilot gate as **still blocked**.
- [ ] Record the missing `DESIGN.md` as a documentation dependency.
- [ ] Record the database test-count mismatch for reconciliation.

### Step 0.2 — Create the synthetic corpus generator

- [ ] Create `tests/fixtures/generator/`.
- [ ] Generate 100 labelled synthetic or redacted onboarding document cases.
- [ ] Cover identity, address, education, employment, bank, tax, photo, and other classes.
- [ ] Include English, Hindi, and Tamil samples where claimed.
- [ ] Use deterministic seed and watermarks.
- [ ] Never create a valid Aadhaar, PAN, bank number, or real person identity.
- [ ] Include at least 10 hostile files: wrong extension, oversized file, decompression bomb, malformed PDF, image pixel overflow, archive, prompt injection, malware-test fixture, empty file, and unsupported MIME.
- [ ] Produce a manifest with class, language, expected fields, expected route, sensitivity, and expected terminal state.

### Step 0.3 — Agree the routing matrix

Define and sign the nine POC scenarios before benchmark execution:

| Scenario | Expected route |
|---|---|
| High-confidence low-risk document with complete evidence | Deterministic auto-proceed to approval |
| Low-confidence class | Human review |
| Missing required field | Human review or rework |
| Conflicting model/rule evidence | Human review |
| Sensitive document/action | Human review and approval |
| Unsafe or quarantined file | Quarantine; no AI progression |
| Malformed AI response | Retry or dead letter; never approval |
| Unknown external outcome | Status lookup or human-authorized replay |
| Government document disallowed by workspace policy | Reject/quarantine; no extraction |

The exact numeric thresholds are internal assumptions and must be pre-registered before benchmarking.

### Step 0.4 — Pre-register the benchmark

- [ ] Create `docs/benchmarks/preregistration.yaml`.
- [ ] Record corpus hash, model candidate, OCR runtime, target class metrics, p50/p95 latency, peak RSS, queue age, calibration, and failure-rate thresholds.
- [ ] Lock the file before running the benchmark.
- [ ] Any later change requires an ADR and a new benchmark version.

### Step 0.5 — Continue discovery later

When outreach begins, collect 15–20 interviews and seek the original gate: at least 8 of the first 15 name the same rework problem and 3 firms commit to pilots. Record exact source questions as a documentation update if the missing Sales Strategy table is found.

## 5.2 Phase 0 prompts

### Prompt 0.1 — Synthetic corpus generator

```text
Create tests/fixtures/generator as a standalone Python 3.12 generator and validator for 100 labelled SYNTHETIC employee-onboarding document cases. Use a deterministic seed, watermarks, invalid/non-real identity values, English/Hindi/Tamil coverage, the approved classes, expected extraction labels, sensitivity flags, expected routes, and at least 10 hostile files. Add a README, manifest, validator, and tests. Do not use or resemble real personal data. The validator must fail on missing labels, valid-looking IDs, missing hostile fixtures, nondeterminism, or absent watermarks.
```

### Prompt 0.2 — Pre-registration and decision templates

```text
Create docs/benchmarks/preregistration.yaml and docs/decisions/decision-record-template.md. Include corpus hash, model/OCR/engine versions, thresholds, calibration method, latency, peak RSS, queue-age, failure-rate, owner, approval time, and immutable versioning. Add tests that reject benchmark results when the preregistration has been edited after execution.
```

## 5.3 Phase 0 exit test

- [ ] Corpus is reproducible and validated.
- [ ] Routing matrix is signed.
- [ ] Thresholds are pre-registered before benchmark execution.
- [ ] Every POC state from submission to audit is explainable.
- [ ] The one authorized POC action is a synthetic email/notification.
- [ ] No real sensitive data is used.
- [ ] If discovery is not yet complete, the phase record says **Technical build permitted by ADR-17; sensitive pilot blocked**.

**If it fails:** fix the corpus, routing policy, or documentation. Do not weaken thresholds, drop cases, or claim validation.

---

# 6. Phase 1 — Foundations and infrastructure

**Goal:** secure, empty, inspectable two-VM baseline plus local development, configuration validation, CI, and private service boundaries.

## 6.1 Founder/operator steps

1. Open the OCI console and complete the Day-1 check for Server #1: state, account type, shape, OCPU/RAM, storage, quotas, warnings, and Oracle notices.
2. Verify that the two-account arrangement is authorized and consistent with the account holder’s terms. Do not assume two accounts under one person are permitted.
3. Do not upgrade to Pay-As-You-Go or resize without a new decision.
4. Apply host hardening before any data: key-only SSH, password login disabled, root login disabled, least-privilege sudo, no public port 22, automatic updates, and a tested second administrative session.
5. Configure VM1 and VM2 network boundaries. No public PostgreSQL or AI ports. VM2 has no general outbound internet or cloud credentials.
6. Configure Cloudflare Tunnel/Access and signed VM1-to-VM2 requests.
7. Create Netlify preview/production contexts; no production secrets in preview.
8. Create Clerk development/production instances with MFA for owners/admins.
9. Create private R2 quarantine, documents, and backups boundaries with scoped tokens and lifecycle rules.
10. Verify Resend domain and record SPF/DKIM/DMARC status without sending customer data.
11. Configure external uptime/heartbeat monitoring and receive one test alert.
12. Enable repository branch protection, MFA, secret scanning, dependency scanning, and required checks.

## 6.2 Coding steps

1. Create pnpm workspace manifests.
2. Create strict TypeScript base configuration.
3. Create Fastify API health route.
4. Create configuration schema that fails fast but never echoes secret values.
5. Create ARM-compatible Compose files for VM1 and VM2.
6. Create an idempotent, dry-run-capable Oracle Linux hardening script.
7. Create CI for install, lint, typecheck, tests, DB checks, secret scan, Semgrep, and Trivy.
8. Create `make verify` as the stable required check.
9. Add an evidence template for Phase 1.

## 6.3 Phase 1 prompts

**Prompt 1.1 — Monorepo scaffold**

```text
Scaffold the approved Formiva monorepo with pnpm workspaces, strict TypeScript, apps/web, apps/api, apps/worker, services/ai-engine, packages/db/contracts/policy/workflow/crypto/integrations/config/observability, infra, docs and tests. Add a Fastify /healthz route, placeholder app entry points, environment validation that fails safely without echoing values, ESLint, Prettier, Vitest, and Makefile targets. Do not add business behavior or new providers. `make verify` must pass on a clean clone.
```

**Prompt 1.2 — VM Compose files**

```text
Write linux/arm64 Compose definitions for VM1 and VM2. VM1 contains API, worker, scheduler, integration worker, PostgreSQL, ClamAV and backup service. VM2 contains only AI Engine and lightweight metrics. Do not publish PostgreSQL, AI, or SSH ports to 0.0.0.0. Add health checks, resource limits, log rotation, non-root containers where possible, and .env.example placeholders. `docker compose config` must pass.
```

**Prompt 1.3 — Host hardening**

```text
Write infra/scripts/harden-oracle-linux9.sh. It must be idempotent, support --dry-run, show PASS/FAIL per control, refuse to lock out the current operator, configure key-only SSH, disable password/root login, replace broad NOPASSWD access, restrict port 22, apply updates, and preserve a tested second session. Add tests or static checks and a runbook.
```

**Prompt 1.4 — CI**

```text
Create .github/workflows/ci.yml for every push and pull request. Run pnpm install with lockfile, lint, typecheck, unit tests, database tests, secret scan, Semgrep, Trivy, and migration/OpenAPI drift checks. A deliberately committed fake secret must fail the build. Do not use real secrets.
```

## 6.4 Phase 1 exit test

- [ ] Clean clone passes `make verify`.
- [ ] Compose files validate.
- [ ] External scan finds only intended Cloudflare-fronted HTTPS exposure.
- [ ] No public PostgreSQL, AI, or SSH port.
- [ ] VM1 reaches VM2 only through protected tunnel/access and signed requests.
- [ ] VM2 has no cloud credentials or unrestricted internet access.
- [ ] Netlify, Clerk, R2, and Resend environments are separated.
- [ ] Host hardening evidence is saved.
- [ ] No third VM or unapproved provider exists.

**If it fails:** fix network and host boundaries before writing application behavior.

---

# 7. Phase 2 — Database and tenant authorization

**Goal:** deploy the tested PostgreSQL schema and make every API request tenant-scoped, permission-checked, and audited. A technical reviewer is required.

## 7.1 Minute steps

1. Copy the delivered SQL package into `packages/db/migrations` without editing applied migrations.
2. Write the migration runner and checksum table.
3. Run the actual SQL package test suite and record the real count; reconcile the 107/99/81 documentation mismatch.
4. Create runtime LOGIN roles inheriting from group roles.
5. Ensure the application role is not a superuser and has no `BYPASSRLS`.
6. Implement `withTenant()` using transaction-local `app.set_context(workspace_id, user_id)`.
7. Implement Clerk JWT verification and workspace membership lookup.
8. Treat the workspace header as a selector only; never trust a client-supplied workspace ID as authorization.
9. Implement role permissions: owner, admin, reviewer, approver, integration operator, auditor, viewer.
10. Build workspace and member endpoints with audit events.
11. Build cross-tenant negative tests for every route.
12. Verify append-only triggers, immutable published versions, state transitions, and audit hash chain.

## 7.2 Prompts

**Prompt 2.1 — Database package**

```text
Implement packages/db around the delivered SQL-first migrations: ordered runner, checksum verification, Drizzle types, withTenant() helper, non-superuser runtime connection, and tests proving no tenant context returns zero rows. Do not create a second queue state or edit an applied migration. Run and report the actual SQL test count.
```

**Prompt 2.2 — Auth and authorization**

```text
Create the Fastify auth plugin. Verify Clerk JWT issuer, audience, expiry and authorized party. Resolve membership and role. Treat the workspace header as a selector that must match membership. Fail closed, return 404 for foreign identifiers to avoid existence leaks, and attach tenant context only inside the transaction helper. Add wrong-user, wrong-role, expired-token, missing-token and foreign-workspace tests.
```

**Prompt 2.3 — Workspace bootstrap and members**

```text
Implement POST /v1/workspaces, workspace members list/invite/role change/remove endpoints using the approved schema. Protect the last owner, audit every change, set tenant context, validate request/response with Zod, and update OpenAPI. Add two-workspace integration tests.
```

**Prompt 2.4 — Tenant-isolation suite**

```text
Create tests/security/tenant-isolation.test.ts. Seed two workspaces and attempt every API operation with foreign case, document, job, result, workflow, integration, billing and audit identifiers, no auth, and insufficient roles. Make the test fail when a new route is added without authorization coverage. Keep the suite under three minutes in CI.
```

## 7.3 Phase 2 exit test

- [ ] Actual SQL checks pass and count is documented.
- [ ] Cross-tenant suite passes.
- [ ] A hand-written query through the app role cannot read another workspace.
- [ ] No context returns zero rows.
- [ ] Published versions and evidence are immutable.
- [ ] State transitions and audit chain are enforced by the database.
- [ ] Reviewer signs the evidence.

**If it fails:** stop. Every later phase depends on this boundary.

---

# 8. Phase 3 — Intake, forms, uploads, and file safety

**Goal:** a synthetic respondent can use a mobile form, save/resume, upload files, and submit only after files pass the safety pipeline.

## 8.1 Minute steps

1. Define the versioned form schema with fields, required flags, document slots, policy IDs, and accessibility labels.
2. Build public respondent-link token hashing and resolution.
3. Record consent before saving values.
4. Build public form GET, draft PUT, upload-request POST, and submit POST routes.
5. Enforce upload size, MIME, extension, page, pixel, archive, decompression, and rate limits.
6. Write only to the quarantine bucket through exact presigned requests.
7. Run file sniffing, ClamAV, PDF/image limits, metadata stripping, and SHA-256 hashing.
8. Promote only clean files to the tenant-scoped documents bucket.
9. Store scan results and quarantine reasons.
10. Implement the Government Documents Policy in API, form slots, and admin screen.
11. Ensure masked Aadhaar policy and prohibited document classes are database-enforced.
12. Implement one-transaction submission: case, values, document metadata, AI jobs, and audit event before worker polling.

## 8.2 Prompts

**Prompt 3.1 — Forms and public renderer**

```text
Implement the versioned form definition in packages/contracts and the public Next.js renderer. Support required fields, document slots, plain-language errors, keyboard navigation, 375px mobile layout, save/resume and published-version immutability. Add Playwright and axe tests. Do not invent UI patterns; follow DESIGN.md when supplied.
```

**Prompt 3.2 — Tokens, rate limits, consent**

```text
Implement signed public respondent tokens as hashes only, public form resolution, draft save, upload-request and submit routes. Resolve workspace/form/version from the token; never accept workspace scope from the request body. Record consent before saving data. Add per-token/IP rate limits and safe error responses.
```

**Prompt 3.3 — Upload and scanner worker**

```text
Implement quarantine-only upload flow and scanner worker. Enforce MIME and extension sniffing, size/page/pixel/archive/decompression limits, ClamAV, SHA-256, image metadata stripping, tenant-scoped object keys, scan records, quarantine reason, and clean promotion. Run every hostile Phase 0 fixture. Nothing unscanned may be readable by application or AI code.
```

**Prompt 3.4 — Atomic submission**

```text
Implement POST /public/v1/submit as one withTenant transaction: validate published form, consent, values, clean documents, case, document metadata, one durable AI job per document with deterministic idempotency key, and audit event. Test process kill/retry so the result is all-or-nothing and duplicate submit creates one case/effect.
```

**Prompt 3.5 — Government Documents Policy**

```text
Implement the approved Government Documents Policy across API, form document slots and admin screen. Require opt-in and stated purpose per type, masked Aadhaar copy only, ciphertext for full identifiers, last-four display only, and reject caste/community/police documents. The system reads/extracts; it never verifies authenticity. Add tests for permitted, missing-policy, prohibited, unmasked and cross-tenant cases.
```

## 8.3 Phase 3 exit test

- [ ] Mobile synthetic form completes, saves, resumes, and submits.
- [ ] All hostile files are quarantined.
- [ ] Clean file has hash, metadata, retention state, scan result, and audit event.
- [ ] No unscanned file reaches AI.
- [ ] Submission is atomic.
- [ ] Government policy tests pass.
- [ ] No ID number is exposed in clear text, URL, log, or fixture.

---

# 9. Phase 4 — Review queue, approvals, and case timeline

**Goal:** a reviewer can resolve exceptions without losing original evidence, and an approver can approve, reject, delegate, or request rework with a complete timeline.

## 9.1 Minute steps

1. Build review-task filters for status, priority, due time, sensitivity, and reason.
2. Implement atomic claim with row version/lease so two reviewers cannot claim one task.
3. Show source document through a 60-second signed URL with watermark and masked values by default.
4. Show extracted fields, source evidence, confidence components, rules, policy, model/runtime metadata, and escalation reason.
5. Implement correction as an append-only human correction plus new case-value revision and superseding routing decision.
6. Add approval rounds, approvers, reason requirements, delegation, rejection, and rework.
7. Enforce database approval guard for sensitive action execution.
8. Build case timeline from durable events, not UI-only state.
9. Build reviewer console and approval UI using DESIGN.md.
10. Test wrong reviewer, wrong approver, foreign case, missing reason, and sensitive reveal audit.

## 9.2 Prompts

**Prompt 4.1 — Review tasks and corrections**

```text
Implement review-task list, claim, resolve, rework and correction APIs. Use optimistic locking or durable claim lease. A correction must preserve original AI result/evidence, insert human_corrections and a new routing decision, require a reason, and audit the action. Add two-reviewer race and foreign-case tests.
```

**Prompt 4.2 — Approvals and timeline**

```text
Implement approval rounds and decisions for approve, reject, delegate and request-rework. Require actor, reason, time and workflow step. Prevent sensitive action execution without complete approval. Build the case timeline from audit and durable state. Add rejection, delegation, rework, duplicate decision and unauthorized-role tests.
```

**Prompt 4.3 — Reviewer console**

```text
Build the reviewer/approver console: queue, filters, case detail, source evidence, masked-by-default values, audited reveal, correction, approval and timeline. Use flat bordered panels and the supplied DESIGN.md; do not introduce glassmorphism, gradients, sparkle icons or hover-scale effects. Add Playwright accessibility and low-confidence resolution tests.
```

## 9.3 Phase 4 exit test

- [ ] Two reviewers cannot claim the same task.
- [ ] Original AI result and evidence remain visible.
- [ ] Correction creates new rows, not overwrite.
- [ ] Approval rejection, delegation, and rework are durable.
- [ ] Sensitive reveal is permission-checked and audited.
- [ ] Timeline shows correlation-linked state changes.

---

# 10. Phase 5 — Durable workers, scheduler, and Resend adapter

**Goal:** jobs survive restarts; duplicates create one business effect; failures remain visible; replay is safe.

## 10.1 Minute steps

1. Implement worker roles and graceful shutdown.
2. Claim PostgreSQL jobs with `FOR UPDATE SKIP LOCKED` and leases.
3. Heartbeat leases and abort work when lease ownership is lost.
4. Implement retries with transient/permanent/unknown classification.
5. Implement dead-letter and authorized replay.
6. Implement workflow-step runner with durable step claims.
7. Implement one scheduler instance for lease requeue, retention, audit anchor, backups, and health jobs.
8. Implement adapter interface: validateConfig, healthCheck, dryRun, execute, classifyError, lookupStatus, redact.
9. Implement Resend email in safe mode with idempotency key.
10. Separate notification delivery status from business-action status.
11. Run chaos tests: duplicate delivery, worker restart, lease expiry, timeout, dead letter, unknown outcome.

## 10.2 Prompts

**Prompt 5.1 — Worker loop and scheduler**

```text
Implement apps/worker around PostgreSQL claim functions, leases, heartbeats, graceful shutdown, retry/backoff, dead letters, correlation IDs and metrics. PostgreSQL is the queue source of truth. Add a single scheduler role and tests for restart, lost lease, expired lease and no duplicate claim.
```

**Prompt 5.2 — Workflow runner**

```text
Implement packages/workflow JSON schema and durable step runner for trigger, condition, validation, review, approval, notification, integration, wait, and terminal nodes. Enforce step leases, immutable workflow version, safe mode, idempotency and no external writes during dry-run. Add tests for every node and restart between steps.
```

**Prompt 5.3 — Integration executor and Resend**

```text
Implement the adapter interface and Resend adapter. Validate configuration, use credential references only, create integration_interactions and execution attempts, classify success/transient/permanent/unknown, perform status lookup for unknown, use the same business idempotency key, and redact logs. Add fake-provider tests.
```

**Prompt 5.4 — Chaos tests**

```text
Create tests/integration/chaos.test.ts against real PostgreSQL. Test duplicate delivery, worker restart, lease expiry, transient retry, permanent failure, dead-letter, unknown external outcome and authorized replay. Require zero silent loss and one business effect per idempotency key across three runs.
```

## 10.3 Phase 5 exit test

- [ ] Duplicate delivery creates one business effect.
- [ ] Failed job remains visible with attempts, lease, error class, and correlation ID.
- [ ] Worker restart resumes without losing state.
- [ ] Unknown external outcome never blindly retries.
- [ ] Chaos report shows zero silent loss.

---

# 11. Phase 6 — AI Engine on VM2

**Goal:** private CPU-only document service returns bounded, evidence-linked suggestions; it decides nothing.

## 11.1 Minute steps

1. Build FastAPI service with one worker and private port only.
2. Implement HMAC timestamp/nonce/body-hash request verification.
3. Reject replayed nonce, wrong signature, wrong hash, wrong tenant/job ownership, oversized body, and unsupported MIME.
4. Safely open PDFs without JavaScript or external references.
5. Extract text layer; run bounded OCR for image pages.
6. Detect English, Hindi, and Tamil/script ratio where supported.
7. Classify only from allowed classes and return unknown for uncertainty.
8. Extract only fields grounded in OCR/source evidence.
9. Compute model, OCR, evidence, and rule-agreement confidence components.
10. Scrub full identifiers and prompt-injection instructions from output.
11. Include model ID/version/digest, OCR/runtime version, engine version, timing, trace ID, source evidence references, sensitivity, and routing recommendation.
12. Calibrate thresholds by class and record corpus hash.
13. Benchmark on the real VM2 shape under mixed load.
14. Implement government-document subtype and offline format checks without authenticity claims.

## 11.2 Prompts

**Prompt 6.1 — Service skeleton and signing**

```text
Create services/ai-engine using Python 3.12, FastAPI, Pydantic v2 and one uvicorn worker. Implement POST /v1/ai/jobs with request schema, response schema, HMAC timestamp/nonce/body-hash verification, replay rejection, size/MIME limits, trace IDs and redacted errors. No general internet access, cloud credentials or arbitrary object URLs.
```

**Prompt 6.2 — OCR and language**

```text
Implement bounded PDF/image preprocessing: no JavaScript or external references, page/pixel/temp limits, text-layer extraction, Tesseract OCR for supported languages, language detection, safe cleanup and timeout. Add corpus reports for character quality by language/format and tests for empty, malformed, oversized and pixel-overflow files.
```

**Prompt 6.3 — Classification, extraction, grounding**

```text
Implement constrained classification and extraction using the approved local model runtime. Allowed classes only; unknown is valid. Every extracted value must be grounded in source evidence; otherwise null. Detect prompt injection, return it as a signal, never follow document instructions, scrub full IDs, and emit schema-validated advisory JSON only.
```

**Prompt 6.4 — Confidence and calibration**

```text
Implement model, OCR, evidence and rule_agreement components in [0,1], overall minimum, calibration per class, corpus hash, calibration version, reliability tables and expected calibration error. Uncalibrated classes cannot auto-proceed. Tests must prove changing a threshold requires a new preregistration/decision.
```

**Prompt 6.5 — Benchmark and model registry**

```text
Create tests/ai-benchmark/run.py and a formiva-models CLI. Benchmark the locked corpus on the real VM2 shape and record accuracy, precision/recall by class, calibration, p50/p95 latency, peak RSS, queue age, timeout/failure rate, model license, digest, OCR and engine versions. Do not promote a model without threshold and license evidence.
```

**Prompt 6.6 — Government extractors and offline checks**

```text
Implement government.py for permitted subtype classification and offline format checks only. Never call an authenticity service and never say verified. Require masked Aadhaar handling, last-four display, ciphertext boundary for full IDs, and no AI extraction for caste/community/police classes. Use at least 30 synthetic examples per supported subtype including bad checksum, masked and unmasked inputs.
```

## 11.3 Phase 6 exit test

- [ ] Benchmark is pre-registered and immutable.
- [ ] p50/p95, peak RSS, queue age, accuracy, calibration, and failures are recorded.
- [ ] Version metadata is in every execution.
- [ ] Prompt injection never changes the allowed schema or causes action.
- [ ] No sensitive action can auto-execute.
- [ ] Government policy is enforced and no authenticity claim exists.

---

# 12. Phase 7 — Exact routing and complete synthetic loop

**Goal:** backend decides every route; the complete synthetic case reaches an audited final state; POC decision is made.

## 12.1 Minute steps

1. Implement pure `packages/policy.decideRoute(input)` with no I/O.
2. Recompute final routing from evidence, policy, sensitivity, confidence, action risk, safe mode, and idempotency.
3. Store routing decision and reasons immutably.
4. Implement AI result transaction: execution, result, evidence, extraction, validation, decision, review task/advance, lease clear, audit.
5. Implement post-approval route to one synthetic Resend notification and confirmation.
6. Run the full demo: token form → consent → upload → scan → case/job → AI → route → review or auto-proceed → approval → notification → audit.
7. Verify every one of the 100 corpus cases has a terminal explainable state.
8. Test duplicate submit, duplicate job, malformed AI response, worker restart, unknown email outcome, and replay.
9. Run encrypted backup and isolated restore before POC sign-off.
10. Complete the POC sign-off record: Proceed, Change Approach, or Not Sensitive-Pilot Ready.

## 12.2 Prompts

**Prompt 7.1 — Routing function**

```text
Implement a pure, exhaustively tested decideRoute(input) function. Inputs include confidence components, calibration, evidence, deterministic checks, policy, sensitivity, action risk, AI/rule agreement, file-safety result, safe mode and idempotency. Output route, reasons and required next state. Sensitive/irreversible actions, uncertainty, conflict, unsafe files, missing evidence and unknown outcomes must never auto-proceed.
```

**Prompt 7.2 — AI transaction and review**

```text
Implement the worker AI-job handler. Fetch clean bytes, verify hash, call the private signed AI Engine, validate response ownership/schema/policy/version, insert append-only execution/result/evidence/extraction/validation rows, call backend routing, create review task or advance, update job state, and audit in one transaction. Malformed output must be visible retry/review/dead-letter, never approval. Replay is idempotent.
```

**Prompt 7.3 — Post-approval pipeline**

```text
Implement the post-review/post-approval pipeline: route to configured team, create approvals, execute one authorized fake/safe-mode email, record interaction/execution/notification and provider outcome separately, create confirmation and final audit. Unknown delivery must route to lookup/review. Add full integration test.
```

**Prompt 7.4 — POC demonstration and evidence pack**

```text
Create tests/e2e/poc-demo.spec.ts and an evidence-pack command. Run the complete synthetic onboarding loop, capture traces, routing decisions, review/correction, approval, notification, audit chain, duplicate effect result, backup checksum and isolated restore. Fail the pack if any case lacks a terminal explainable state or a critical security/data-loss check fails.
```

## 12.3 Phase 7 exit and POC decision

Every routing scenario passes; the synthetic loop reaches final audit; zero silent loss; tenant isolation passes; backup restore works; safe replay works; no critical security or data-loss defect remains.

Record exactly one:

- **Proceed:** continue to gated editor/integration work when the separate gate permits.
- **Change approach:** change model, resource, routing, or operating assumption and rerun affected evidence.
- **Not sensitive-pilot ready:** continue synthetic work only; no real sensitive data.

---

# 13. Phase 8 — Visual workflow editor (gated)

**Gate:** do not begin merely because Phase 7 passed. Current project planning gates this breadth behind three paid pilots or an approved pilot-request exception. The current user’s demo-first decision does not silently remove that gate.

**Goal:** an administrator can safely draft, lint, dry-run, publish, and roll back immutable workflow versions.

## 13.1 Steps

1. Implement workflow JSON schema for the approved node types.
2. Implement linter for unreachable nodes, invalid cycles, missing configs, missing approval/error paths, forbidden side effects, unsupported connector scopes, and safe-mode incompatibility.
3. Implement dry-run with synthetic fixtures and zero external writes.
4. Implement workflow CRUD, draft/version/publish/rollback API.
5. Freeze published versions and record publish/rollback events.
6. Build React Flow editor only after `DESIGN.md` is available or a design decision is recorded.
7. Restrict palette to safe supported nodes; do not make a free-form code generator.
8. Add Playwright rebuild/publish/rollback test.

## 13.2 Prompts

- **Prompt 8.1:** implement `lint(definition, context)` with machine-readable errors/warnings and safety tests.
- **Prompt 8.2:** implement `dryRun(definition, fixture)` with no external interactions and intended-action report.
- **Prompt 8.3:** implement immutable draft/version/publish/rollback APIs with audit and OpenAPI.
- **Prompt 8.4:** implement the editor using the approved design, limited node palette, accessible keyboard interactions, and publish-blocking lint errors.

## 13.3 Exit test

Dry-run makes no external writes; published versions are immutable; rollback is audited; unsafe fixtures are blocked; editor accessibility and usability evidence is recorded.

---

# 14. Phase 9 — Integrations (gated)

**Goal:** connectors work reliably, use safe mode and idempotency, and never send twice.

## 14.1 Order and steps

1. Implement signed outbound webhook adapter.
2. Block SSRF to localhost, private ranges, metadata endpoints, redirects to internal hosts, and unsupported schemes.
3. Implement Google Sheets with least-privilege access and idempotent row behavior.
4. Implement Razorpay test-mode event verification and reconciliation; do not process payments on behalf of the user in this task.
5. Implement generic connector catalog and category boundary from migration 008.
6. Add connector health, dry-run, disable/safe-mode, credential references, redaction, lookup status, and audit.
7. Run 1,000-event reliability test.

## 14.2 Prompts

- **Prompt 9.1:** webhook adapter with URL validation, SSRF/redirect tests, signed payload, idempotency and unknown outcome handling.
- **Prompt 9.2:** Google Sheets adapter with scoped credential reference, mapping validation, one-row idempotency, and crash-after-write recovery.
- **Prompt 9.3:** Razorpay webhook endpoint with signature verification, replay protection, out-of-order convergence, and reconciliation.
- **Prompt 9.4:** 1,000 synthetic integration events across connectors with zero duplicate effects or silent loss.

## 14.3 Exit test

The 1,000-event report passes; every connector honours safe mode; credentials are references only; the failing connector can be disabled without deleting durable state.

---

# 15. Phase 10 — Hardening and sensitive-pilot gate

**Goal:** prove recovery, rotation, alerting, retention/deletion, threat controls, and incident response before deciding whether any real sensitive data may enter.

## 15.1 Security and threat model checklist

Threats to test explicitly:

| Threat | Required control/test |
|---|---|
| Cross-tenant access | Composite keys, forced RLS, API auth, negative tests, 404 foreign IDs. |
| Stolen respondent token | Hash only, expiry/scope, rate limit, no sensitive data in URL. |
| Malicious upload | MIME sniffing, limits, ClamAV, quarantine, archive rejection, safe rendering. |
| Prompt injection | Treat documents as data, bounded schema, no tool execution, test hostile text. |
| AI hallucination | Evidence grounding, calibration, backend routing, human review. |
| Sensitive auto-action | Database approval guard, safe mode, deterministic policy. |
| Duplicate/unknown provider effect | Idempotency, in-flight state, status lookup, human replay. |
| SSRF | URL allow/deny rules, no private ranges, redirect checks. |
| Secret theft | Secret references, redacted logs, scanning, rotation, no AI prompts. |
| Host compromise | SSH hardening, no public ports, least privilege, updates, minimal containers. |
| Backup exposure | Encryption, checksum, retention, isolated restore, access review. |
| Audit tampering | Append-only events, hash chain, daily external anchor, verification drill. |
| Data retention violation | Retention policy, deletion workflow, legal hold, evidence. |
| Supply-chain compromise | Lockfile, dependency scan, signed/tagged releases, ARM verification. |

## 15.2 Minute steps

1. Create encrypted PostgreSQL and R2 metadata backup procedure.
2. Verify checksum and run isolated restore.
3. Corrupt a backup byte and confirm restore refuses it.
4. Create secret inventory with owner, purpose, location, rotation date, and incident action.
5. Rotate VM1↔VM2 HMAC key with overlap and rollback test.
6. Review Clerk, Cloudflare, R2, Resend, OCI, Netlify, and connector access.
7. Expose redacted `/metrics` and internal dashboards.
8. Configure alerts for uptime, queue age, lease age, heartbeat, dead letters, unknown outcomes, disk, memory, AI latency, review backlog, audit-chain failure, backup failure, and unsafe file rate.
9. Fire every alert in a test and receive it.
10. Implement daily retention sweeper with legal-hold block.
11. Run deletion request/approval/proof flow for R2 objects and database rows/anonymization/crypto-erase where designed.
12. Map OWASP ASVS Level 2 controls and record high-severity findings.
13. Run tenant isolation, SSRF, upload, prompt injection, auth, rate-limit, secret, and dependency tests.
14. Run incident tabletop: public DB port, leaked token, bad connector, lost VM, corrupted backup, unknown payment outcome.
15. Prepare trust evidence pack: data flow, processing roles, subprocessors, encryption, isolation, RBAC/MFA, retention/deletion, audit schema, incident process, implemented/planned/assessment-required controls.
16. Obtain counsel/security review where required. Do not claim DPDP/GDPR/SOC 2/ISO/HIPAA/PCI compliance from architecture alone.

## 15.3 Prompts

- **Prompt 10.1:** encrypted backup and restore-drill scripts with checksum, R2 metadata, isolated restore, corruption test, and report.
- **Prompt 10.2:** secret inventory, rotation runbooks, overlapping HMAC rotation, access review, and dry-run safety.
- **Prompt 10.3:** Prometheus metrics, internal dashboard, alerts, test firing, tenant-scope redaction, and runbook links.
- **Prompt 10.4:** retention sweeper, deletion request/approval, legal hold, object removal, anonymization/crypto-erase, and proof evidence.
- **Prompt 10.5:** ASVS Level 2 mapping, threat-model tests, dependency/container scans, tenant isolation, SSRF, upload, auth, prompt-injection and rate-limit pack.

## 15.4 Sensitive-pilot gate

No real sensitive data enters until all of these are true:

- [ ] No unresolved critical/high security or data-loss defect.
- [ ] Tenant isolation and authorization evidence passes.
- [ ] Government Documents Policy is implemented and reviewed.
- [ ] Encryption, key custody, secret rotation, and access review are evidenced.
- [ ] Backup and isolated restore pass.
- [ ] Retention/deletion/legal hold behavior is tested.
- [ ] Incident response and unsafe-connector stop are documented.
- [ ] AI benchmark and routing gates pass.
- [ ] Trust evidence pack is reviewed.
- [ ] Customer contract, processing roles, notices/consent, and counsel requirements are addressed.
- [ ] Founder signs an explicit **Sensitive Pilot: Allowed / Not Allowed** decision.

---

# 16. Paid pilot operating gate

This is a business and operational gate, not a substitute for security.

Before a paid sensitive pilot:

1. Define one customer workflow and boundary.
2. Use synthetic/redacted data first.
3. Record baseline: time-to-ready, first-pass completeness, HR/operations minutes per hire, reminders, rework loops, approval SLA, review rate, failed action rate, and cost per case.
4. Agree pilot success measures, support model, data terms, retention, and exit plan.
5. Confirm payment/implementation scope without treating pricing hypotheses as facts.
6. Obtain the trust evidence pack and approvals.
7. Start with safe mode and human review for uncertain/sensitive actions.
8. Run a dated pilot decision record.

The current Business Plan says the first offer is implementation-assisted diagnostic and time-boxed pilot. Pricing such as ₹999/month, ₹2,999/month, ₹7,999+ and implementation ranges are hypotheses, not commitments; verify them through actual evidence.

---

# 17. Phase 11 — Measure and decide

**Timing in source plan:** May–June 2027; actual timing depends on the real build and pilot calendar.

**Goal:** decide from measured evidence whether to deepen onboarding, add a second workflow, narrow the offer, or stop/repair.

## 17.1 Steps

1. Create SQL views and analytics API with workspace scope.
2. Measure time-to-ready, first-pass completeness, human-review rate, correction rate, SLA breaches, failed-action rate, queue age, usage, and cost per case.
3. Include provider, AI/OCR, storage, network, retries, payment fees, support, and human review time in cost attribution.
4. Generate customer pilot report: baseline versus measured outcome.
5. Obtain customer approval before using a case study or reference.
6. Review logo retention, workflow retention, second-workflow pull, support minutes, and contribution margin.
7. Reconcile provider terms, quotas, regions, prices, and commercial limits.
8. Review trust metrics: deletion, retention, audit completeness, key rotation, unresolved findings, restore success, and tenant-isolation results.
9. Decide whether to deepen onboarding, add leave/expense/IT, narrow the ICP, or stop.
10. Build a second workflow only if at least 60% of pilot customers activate or request one in writing, or a separately approved paid second-vertical gate passes.

## 17.2 Prompt 11.1 — Analytics

```text
Create workspace-scoped SQL views and an analytics API for time-to-ready, first-pass completeness, human-review rate, correction rate, SLA breaches, failed-action rate, queue age, workflow volume, and cost per case. Use durable facts first and document every derived metric definition. Include provider costs and human review/support minutes. Add tenant, role, privacy and no-sensitive-content tests.
```

## 17.3 Prompt 11.2 — Pilot report

```text
Generate a pilot report comparing baseline and measured outcomes per customer. Include methodology, cohort, workflow/version, data boundaries, missing data, implementation/support time, costs, incidents, trust controls, customer approval status and limitations. Never turn an internal assumption into a guarantee or a legal/compliance claim.
```

## 17.4 Exit test

- [ ] Metrics are reproducible and workspace-scoped.
- [ ] Cost per case includes operational labor and provider costs.
- [ ] Pilot reports are evidence-based and customer-approved before publication.
- [ ] Expansion decision meets the documented gate.
- [ ] Open risks and changed assumptions are recorded in a new decision record.

---

# 18. Final Release Gate — after Phase 11

This is the final checklist for a controlled launch claim. It is not an additional source phase and must not be used to skip failed phase gates.

## 18.1 Product

- [ ] The launch workflow is versioned and bounded.
- [ ] Public respondent form, save/resume, upload, review, approval, action, and audit flow work on supported mobile/browser paths.
- [ ] Reviewer and approver roles are distinct.
- [ ] Workflow versions are immutable after publish.
- [ ] Dashboard metrics have written definitions.

## 18.2 API and backend

- [ ] OpenAPI 3.1 matches actual routes.
- [ ] Every route has request/response schemas, auth, tenant scope, permission checks, safe errors, rate limits, correlation ID, idempotency where applicable, and audit behavior.
- [ ] No raw database access bypasses `packages/db`.
- [ ] No provider result is treated as business success without recorded outcome.

## 18.3 Database

- [ ] Migration checksums and version history are clean.
- [ ] RLS, composite tenant keys, state transitions, append-only evidence, approval guards, and audit hash chain pass.
- [ ] Runtime roles are least privilege.
- [ ] Backups and restore evidence are current.
- [ ] Retention, deletion, legal hold, and crypto-erase decisions are documented.

## 18.4 AI and documents

- [ ] Model/OCR/engine versions, licence, digest, calibration and corpus hash are recorded.
- [ ] Benchmark passes pre-registered thresholds.
- [ ] AI output is advisory only and backend route is deterministic.
- [ ] Prompt injection, hallucination, malformed output, timeout, low OCR and uncertainty route safely.
- [ ] Government documents are never described as verified.
- [ ] Full IDs are never clear text; Aadhaar policy is enforced.

## 18.5 Infrastructure and operations

- [ ] Netlify, OCI, Cloudflare, Clerk, R2, Resend, and any connector terms/limits are verified.
- [ ] No unapproved paid resource exists.
- [ ] VM1/VM2 network and host hardening evidence is current.
- [ ] Monitoring and alert tests have passed.
- [ ] Daily/weekly operator runbooks are usable by a non-developer.
- [ ] Incident, restore, rotation, and safe-mode procedures have been rehearsed.

## 18.6 Legal and trust

- [ ] Processing roles, consent/notice, retention, deletion, cross-border transfer, subprocessors, and customer terms are reviewed.
- [ ] Required counsel/security assessment is complete or explicitly accepted as an open restriction.
- [ ] No blanket DPDP, GDPR, SOC 2, ISO 27001, HIPAA, PCI, authenticity, accuracy, uptime, or zero-cost claim is made without appropriate evidence.

## 18.7 Final decision

Record one:

- **Release approved for the explicitly defined scope.**
- **Release restricted to synthetic/demo use.**
- **Release rejected pending named controls.**

Include release tag, date UTC, owner, reviewer, evidence links, changed assumptions, known limitations, rollback plan, and next review date.

---

# 19. Daily founder checklist

At the start of work:

- [ ] Confirm the current phase and its exit test.
- [ ] Check the decision log for open blockers.
- [ ] Confirm no real data or secrets are in the working set.
- [ ] Select one prompt and one small change.
- [ ] Confirm technical reviewer availability for Phases 2, 5, 6, 7, and 10.

At the end of work:

- [ ] Run verification and the attack test.
- [ ] Review files changed in plain English.
- [ ] Save evidence under the phase folder.
- [ ] Update assumptions, risks, and next action.
- [ ] Do not mark a phase complete until its exit test and decision record are signed.

---

# 20. Current next action, exactly one step

## Build Phase 1 Prompt 1.1

Open the repository root and ask the AI coding tool:

```text
Use the Formiva Master Build Roadmap and its Master Context Block. Execute only Phase 1, Prompt 1.1: scaffold the minimal compiling monorepo and configuration validation. First list the files you will create or modify. Do not implement forms, database behavior, AI behavior, integrations, billing, or dashboard features. Add pnpm workspaces, strict TypeScript, Fastify /healthz, safe environment validation, lint, format, tests, and Makefile `make verify`. Use placeholders only. Then run the checks and report files, commands, tests, evidence, and uncertainties.
```

**Do not proceed to Prompt 1.2 until Prompt 1.1 passes on a clean clone.**

---

## Appendix A — Phase decision record template

```text
Phase:
Release/fixture version:
Date and time UTC:
Owner:
Technical reviewer:
Scope completed:
Controls implemented:
Controls planned:
Controls assessment-required:
Tests run and results:
Attack/negative tests:
Evidence paths:
Failed checks:
Changed assumptions:
Open risks:
Decision: PASS / FAIL / RESTRICTED
If restricted, allowed use:
Next action and owner:
```

## Appendix B — Evidence naming convention

Use names such as:

```text
docs/evidence/phase-1/2026-10-03-prompt-1.1-verify.txt
docs/evidence/phase-2/2026-10-03-tenant-negative-suite.txt
docs/evidence/phase-6/2026-10-03-ai-benchmark-v1.json
docs/evidence/phase-10/2026-10-03-restore-drill-report.md
```

## Appendix C — Status labels

- **Implemented:** demonstrated in code and evidence.
- **Planned:** specified but not demonstrated.
- **Assessment-required:** needs legal, security, privacy, or vendor review.
- **Verify:** provider fact, price, quota, or term must be checked.
- **Hypothesis:** planning number that must be replaced by measurement.
- **Synthetic-only:** allowed for demo/testing, not customer production use.
