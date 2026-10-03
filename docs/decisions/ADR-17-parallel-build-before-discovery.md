# ADR-17: Parallel demo build before completing discovery

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owner:** Founder
- **Supersedes:** The sequencing assumption that no implementation work may begin until the Phase 0 interview gate is complete.

## Decision

Begin the synthetic-only Formiva demo build now while customer interviews and outreach are deferred until the demo is usable.

The build may proceed through scaffolding and the planned technical phases, but the following gates remain mandatory before any sensitive-data pilot, production claim, or customer-data processing:

1. Discovery evidence is collected later and reviewed before the sensitive-pilot gate.
2. The product remains synthetic or redacted-data-only until that gate passes.
3. No real ID numbers, customer documents, credentials, secrets, or production database dumps may be used in coding, fixtures, tests, screenshots, or AI prompts.
4. The 8-of-15 repeated-problem and 3-pilot criteria remain the approved business-validation criteria; they are deferred, not waived.
5. Any resulting scope, roadmap, or architecture change receives a further numbered ADR.

## Reason

The founder has chosen to create a demo before approaching companies. A usable demo is expected to improve later outreach, but it does not establish customer demand or justify sensitive production use.

## Consequences

### Positive

- Technical implementation can begin immediately.
- A synthetic demo can support later company outreach.
- The interview gate can use a concrete demo rather than only a concept.

### Negative

- Product risk is being accepted before demand is validated.
- The team may build features that interviews would have deprioritized.
- The roadmap and dashboard must distinguish **demo progress** from **market validation**.

## Required follow-up

- Update the Review & Change Register and project dashboard to reference ADR-17.
- Keep discovery evidence visible as an outstanding gate.
- Do not label the demo as production-ready or pilot-ready merely because it runs.
