# Formiva CaseFlow v2.1 - database package (PostgreSQL 16)

Tested: 107 automated checks pass (tenant isolation, append-only tables, audit hash chain, published-version
immutability, state machines, approval guard, idempotency, job leases, reaper, role privileges, government-document
policy, generic connector catalog) plus a 12-session concurrent claim race. Re-run them after EVERY schema change.

## Apply (fresh database)
    createdb formiva
    for f in migrations/00*.sql; do psql -v ON_ERROR_STOP=1 -1 -d formiva -f $f; done      # as a superuser / migration admin

## Test
    psql -v ON_ERROR_STOP=1 -d formiva -f tests/01_fixtures_and_tests.sql
    psql -v ON_ERROR_STOP=1 -d formiva -f tests/02_queues_roles.sql
    psql -v ON_ERROR_STOP=1 -d formiva -f tests/04_government_documents.sql
    psql -v ON_ERROR_STOP=1 -d formiva -f tests/05_generic_connectors.sql
    bash tests/03_concurrency.sh          # edit the database name inside if needed
    # tests create a schema called tf (test fixtures) - run them on a TEST database, never on production data.

## Production notes
* Create LOGIN roles from the four NOLOGIN groups, e.g.  create role api_login login password '<from secret store>' in role formiva_app;
* The API and workers must run:  select app.set_context(<workspace_uuid>, <user_uuid>);  at the start of EVERY transaction
  (or  select set_config('app.workspace_id', $1, true)  ). No context = zero rows visible.
* Never connect the application as a superuser or as a role with BYPASSRLS. Only formiva_definer (NOLOGIN) has BYPASSRLS.
* Do not edit an applied migration. Add 007_..., 008_... files.

## Government documents (migration 007)
Call `select app.seed_document_policies(<workspace>)` right after `app.bootstrap_workspace(...)`. It creates the default collection
policy for the ten government-issued document types; the employer then edits it. A government document cannot be stored unless
the workspace has a policy that allows it, and Aadhaar policies must require a masked copy.

## Generic connectors (migration 008)
Providers are no longer a fixed list. `connector_categories` (12 categories: ticketing, crm, hrms, lms,
sis_university, spreadsheet, payments, messaging, webhook, identity, storage, other) and `connector_templates`
(documented free/open-source examples) let you add a ticketing tool, CRM, HRMS, LMS or university system by
configuration plus one small adapter, never a schema change. `integration_connections.provider` must match
`^[a-z][a-z0-9_]{1,39}$`.
