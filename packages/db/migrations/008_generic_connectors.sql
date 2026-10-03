-- =====================================================================
-- 008_generic_connectors.sql : generalize integrations beyond the launch adapters so any
-- free/open external API (ticketing, CRM, HRMS, LMS, university/SIS systems, and more) can be
-- connected without a schema change. Adapters are still Formiva code (Coding Plan Prompt 9.5);
-- this migration only removes the fixed provider list and adds a documented catalog.
-- =====================================================================
create table connector_categories (
  key         text primary key,
  description text not null
);
insert into connector_categories (key, description) values
 ('ticketing','Help-desk and ticket tools (e.g. Zammad, Freescout, Freshdesk free tier)'),
 ('crm','Customer relationship management (e.g. EspoCRM, HubSpot free tier)'),
 ('hrms','HR management systems (payroll, leave, attendance)'),
 ('lms','Learning management systems (e.g. Moodle)'),
 ('sis_university','Student information / university management systems'),
 ('spreadsheet','Spreadsheet or lightweight database (e.g. Google Sheets)'),
 ('payments','Payment and billing providers (e.g. Razorpay)'),
 ('messaging','Email or chat notification providers (e.g. Resend)'),
 ('webhook','Generic signed outbound webhook to any system'),
 ('identity','Authentication providers (e.g. Clerk)'),
 ('storage','Object storage providers (e.g. Cloudflare R2)'),
 ('other','Anything not covered above');

-- Documented examples only (not credentials, not code): helps a non-developer pick a free tool.
create table connector_templates (
  id               uuid primary key default gen_random_uuid(),
  category         text not null references connector_categories(key),
  name             text not null,
  homepage_url     text,
  licence_or_plan  text not null,          -- e.g. "open source (AGPL)" or "free tier"
  auth_type        text not null check (auth_type in ('api_key','oauth2','webhook_signature','service_account','basic_auth')),
  notes            text,
  unique (category, name)
);
insert into connector_templates (category, name, homepage_url, licence_or_plan, auth_type, notes) values
 ('ticketing','Zammad','https://zammad.org','Open source (AGPL), self-hosted free','api_key','REST API; self-host on a free VM or use their hosted free trial.'),
 ('ticketing','Freescout','https://freescout.net','Open source (AGPLv3), self-hosted free','api_key','Lightweight, PHP-based, low resource use.'),
 ('crm','EspoCRM','https://www.espocrm.com','Open source (AGPLv3), self-hosted free','api_key','REST API; self-host on a free VM.'),
 ('crm','HubSpot CRM','https://www.hubspot.com','Free tier (contact/deal limits apply)','oauth2','Verify current free-tier API rate limits before relying on it.'),
 ('lms','Moodle','https://moodle.org','Open source (GPLv3), self-hosted free','api_key','Web services API (REST); self-host on a free VM.'),
 ('sis_university','Generic REST/webhook adapter','','Varies by institution','webhook_signature','Most university ERPs expose a case-by-case API; use the generic webhook or REST adapter rather than a named integration.'),
 ('spreadsheet','Google Sheets','https://www.google.com/sheets/about','Free (Google account quota)','oauth2','Already a launch adapter (Phase 9).'),
 ('payments','Razorpay','https://razorpay.com','No monthly fee; per-transaction fee','api_key','Already a launch adapter (Phase 9).'),
 ('messaging','Resend','https://resend.com','Free tier','api_key','Already a launch adapter (Phase 5).'),
 ('webhook','Generic signed webhook','','Free (customer''s own endpoint)','webhook_signature','Already a launch adapter (Phase 9); works with any system that can receive an HTTPS callback.');

-- Loosen the provider column: any lowercase key, not a fixed list, so a new connector needs no migration.
alter table integration_connections drop constraint integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_format
  check (provider ~ '^[a-z][a-z0-9_]{1,39}$');
alter table integration_connections add column category text references connector_categories(key);

grant select on connector_categories, connector_templates to formiva_app, formiva_worker, formiva_readonly;
grant select, insert, update on connector_categories, connector_templates to formiva_ops;
