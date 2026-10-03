---
name: formiva-project-understanding
description: Consolidated understanding of Formiva project architecture, phases, and governance
metadata:
  type: reference
---

# Formiva Project Core Understanding

## 1. Project Structure & Governance
- **Repository**: `c:\MAIN-DEV-ALL\Formiva` - monorepo with `.claude` skills, `docs`, `apps`, `services`, `packages`, `infra`
- **Governing documents**: <co>CLAUDE.md (engineering OS)</co: 0:[0]>, <co>Formiva_Master_Build_Roadmap.md (phases)</co: 0:[0]>, <co>DESIGN.md (UI/UX)</co: 0:[0]>, <co>HANDOFF.md (status)</co: 0:[0]>, ADRs in `docs/decisions/`
- **Authority hierarchy**: 1) <co>Code/tests</co: 0:[0]>, 2) <co>Infrastructure</co: 0:[0]>, 3) <co>Documentation</co: 0:[0]>, 4) <co>ADRs</co: 0:[0]>, 5) <co>Memory</co: 0:[0]>
- **Current mode**: <co>Demo-first (ADR-17)</co: 0:[0]>; real data blocked until <co>Phase 10</co: 0:[0]>

## 2. Phase Overview
| Phase | Goal | Critical Output | Exit Test |
|---|---|---|---|
| <co>0</co: 0:[0]> | <co>Synthetic corpus, benchmark, decisions</co: 0:[0]> | <co>100 labeled fixtures, pre-registered benchmark</co: 0:[0]> | <co>Reproducible corpus, routing matrix, thresholds</co: 0:[0]> |
| <co>1</co: 0:[0]> | <co>Foundations: API scaffold, VM setup, CI</co: 0:[0]> | <co>Minimal compiling API, VM1/VM2 setup</co: 0:[0]> | <co>`make verify` passes, no public ports</co: 0:[0]> |
| <co>2</co: 0:[0]> | <co>Database + tenant auth</co: 0:[0]> | <co>PostgreSQL schema, `withTenant()` helper</co: 0:[0]> | <co>Cross-tenant isolation suite passes</co: 0:[0]> |
| <co>3</co: 0:[0]> | <co>Intake/forms/upload safety</co: 0:[0]> | <co>Form renderer, quarantine scanner</co: 0:[0]> | <co>Mobile form works, hostile files quarantined</co: 0:[0]> |
| <co>4</co: 0:[0]> | <co>Review/approval flow</co: 0:[0]> | <co>Reviewer console, approval logic</co: 0:[0]> | <co>Two reviewers can't claim same task</co: 0:[0]> |
| <co>5</co: 0:[0]> | <co>Workers/scheduler</co: 0:[0]> | <co>Claim/lease system, chaos tests</co: 0:[0]> | <co>Duplicate delivery creates one effect</co: 0:[0]> |
| <co>6</co: 0:[0]> | <co>AI Engine on VM2</co: 0:[0]> | <co>Private CPU OCR/classification</co: 0:[0]> | <co>Benchmark meets pre-registered thresholds</co: 0:[0]> |
| <co>7</co: 0:[0]> | <co>Complete synthetic loop</co: 0:[0]> | <co>End-to-end demo, audit chain</co: 0:[0]> | <co>All 100 corpus cases explainable</co: 0:[0]> |
| <co>8</co: 0:[0]> | <co>Workflow editor</co: 0:[0]> | <co>Immutable workflow versions</co: 0:[0]> | <co>Dry-run no external writes</co: 0:[0]> |
| <co>9</co: 0:[0]> | <co>Integrations</co: 0:[0]> | <co>Webhook, Sheets, Razorpay adapters</co: 0:[0]> | <co>1000 events, zero silent loss</co: 0:[0]> |
| <co>10</co: 0:[0]> | <co>Hardening & pilot gate</co: 0:[0]> | <co>Backup, alerts, retention</co: 0:[0]> | <co>All ASVS Level 2 controls pass</co: 0:[0]> |
| <co>11</co: 0:[0]> | <co>Measure & decide</co: 0:[0]> | <co>Analytics, pilot report</co: 0:[0]> | <co>Cost metrics reproducible</co: 0:[0]> |
| <co>Final</co: 0:[0]> | <co>Release gate</co: 0:[0]> | <co>Controlled launch claim</co: 0:[0]> | <co>All phase exit tests pass</co: 0:[0]> |

## 3. Design System Rules
- **Visual**: <co>Flat bordered panels, no shadows, teal only for AI signifiers</co: 0:[0]>
- **Typography**: <co>Inter/Geist Sans (body), Geist Mono for machine data</co: 0:[0]>
- **Motion**: <co>Max 240ms, no bounce, one spring-eased success animation</co: 0:[0]>
- **Accessibility**: <co>WCAG 2.2 AA, keyboard-first, focus rings never suppressed</co: 0:[0]>
- **Anti-patterns**: <co>No rounded-card shadows, no generic AI sparkle icons</co: 0:[0]>

## 4. Security Controls
- **Data**: <co>Zero real IDs/documents in repo; synthetic fixtures only</co: 0:[0]>
- **Secrets**: <co>References only, no `.env` files; redacted logs</co: 0:[0]>
- **Access**: <co>Tenant isolation via composite keys + RLS; no BYPASSRLS roles</co: 0:[0]>
- **Files**: <co>Quarantine before scanning; clean files promoted to documents bucket</co: 0:[0]>
- **AI**: <co>Untrusted output; backend recomputes routing</co: 0:[0]>

## 5. Documentation Requirements
- **Meaningful changes**: <co>Update CHANGELOG, add ADR, create dated update in `docs/updates</co: 0:[0]>/`
- **Evidence**: <co>Save test output, screenshots in `docs/evidence/phase-N</co: 0:[0]>/`
- **Phase records**: <co>Template in Appendix A of Roadmap</co: 0:[0]>
- **Design**: <co>Follow DESIGN.md exactly; no replacements without decision</co: 0:[0]>

## 6. Skills Available
- `code-review` (CodeRabbit)
- `design-md` (DESIGN.md generation)
- `security-audit` (full-stack scanner)
- `impeccable` (UI polish)
- `web-design-guidelines` (Vercel guidelines)
- `ui-ux-pro-max` (alternative UI intelligence)

## 7. Immediate Action Items
1. Create `memory.md` (this file) - DONE
2. Execute Phase 1, Prompt 1.1: API scaffold
3. Run `make verify` and security tests
4. Save evidence in `docs/evidence/phase-1/`
5. Update `CHANGELOG.md` with Phase 1 progress

## 8. Remaining Risks
- <co>Customer demand not validated (discovery deferred)</co: 0:[0]>
- <co>Provider terms/limits unverified</co: 0:[0]>
- <co>Database test count reconciliation needed</co: 0:[0]>
- <co>ADR-17 consistency across documents</co: 0:[0]>
- <co>Phase 10 security hardening before any real data</co: 0:[0]>

**Memory created and populated with durable engineering knowledge.**
---
