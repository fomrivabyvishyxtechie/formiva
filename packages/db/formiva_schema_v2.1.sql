-- =====================================================================
-- Formiva CaseFlow v2.1 - PostgreSQL 16 schema
-- 001_foundation.sql : extensions, schemas, roles, helper functions
-- Run as a superuser / migration admin. Apply the files in numeric order.
-- =====================================================================
create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create schema if not exists app;   -- helpers used by RLS, triggers and the application
create schema if not exists ops;   -- privileged (SECURITY DEFINER) queue and metrics functions

-- ---- Runtime roles (NOLOGIN groups). Production creates LOGIN roles that inherit from these. ----
do $$
declare r text;
begin
  foreach r in array array['formiva_app','formiva_worker','formiva_readonly','formiva_ops'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
  -- Definer role: owns the SECURITY DEFINER queue functions. BYPASSRLS is required because
  -- worker queues are claimed across workspaces. It is NOLOGIN and never used by application code.
  if not exists (select 1 from pg_roles where rolname = 'formiva_definer') then
    create role formiva_definer nologin bypassrls;
  end if;
end $$;

-- ---- Request context (set per transaction by the API / worker with set_config(..., true)) ----
create or replace function app.current_workspace() returns uuid
language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create or replace function app.current_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.set_context(p_workspace uuid, p_user uuid default null) returns void
language sql as $$
  select set_config('app.workspace_id', coalesce(p_workspace::text, ''), true),
         set_config('app.user_id', coalesce(p_user::text, ''), true)
$$;

-- ---- Generic triggers ----
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function app.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op using errcode = '55000';
end $$;

-- Clears lease columns whenever a row leaves a leased status (prevents orphaned leases).
create or replace function app.clear_lease_when_not_leased() returns trigger language plpgsql as $$
begin
  if new.status not in ('claimed','running','in_flight') then
    new.lease_owner := null; new.lease_until := null;
  end if;
  return new;
end $$;

-- ---- Explicit state machines ----
create table app.state_transitions (
  entity      text not null,
  from_status text not null,
  to_status   text not null,
  primary key (entity, from_status, to_status)
);

create or replace function app.enforce_transition() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not exists (select 1 from app.state_transitions
                    where entity = tg_argv[0] and from_status = old.status and to_status = new.status) then
      raise exception 'illegal % transition: % -> %', tg_argv[0], old.status, new.status using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---- Version immutability guards ----
-- A published/retired version may not change content; only published -> retired is allowed.
create or replace function app.guard_published_version() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published','retired') then
      raise exception '% % is immutable and cannot be deleted', tg_table_name, old.id using errcode = '55000';
    end if;
    return old;
  end if;
  if old.status in ('published','retired') then
    if (to_jsonb(new) - array['status','updated_at']) is distinct from (to_jsonb(old) - array['status','updated_at']) then
      raise exception '% % is immutable once published', tg_table_name, old.id using errcode = '55000';
    end if;
    if new.status is distinct from old.status and not (old.status = 'published' and new.status = 'retired') then
      raise exception 'illegal version status change % -> %', old.status, new.status using errcode = '55000';
    end if;
  end if;
  return new;
end $$;

-- Children (fields, nodes, edges) of a published/retired version are frozen.
create or replace function app.guard_published_children() returns trigger language plpgsql as $$
declare v_parent uuid; v_status text;
begin
  v_parent := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> tg_argv[1])::uuid;
  execute format('select status from %I where id = $1', tg_argv[0]) into v_status using v_parent;
  if v_status in ('published','retired') then
    raise exception 'parent version % is % - children are immutable', v_parent, v_status using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- ---- Declarative helpers used at the end of each table group ----
create or replace procedure app.tenantize(t regclass) language plpgsql as $$
begin
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('drop policy if exists tenant_isolation on %s', t);
  execute format('create policy tenant_isolation on %s using (workspace_id = app.current_workspace()) with check (workspace_id = app.current_workspace())', t);
end $$;

create or replace procedure app.append_only(t regclass) language plpgsql as $$
declare n text := replace(t::text, '.', '_');
begin
  execute format('drop trigger if exists %I on %s', 'trg_' || n || '_append_only', t);
  execute format('create trigger %I before update or delete on %s for each row execute function app.forbid_mutation()', 'trg_' || n || '_append_only', t);
  execute format('drop trigger if exists %I on %s', 'trg_' || n || '_no_truncate', t);
  execute format('create trigger %I before truncate on %s for each statement execute function app.forbid_mutation()', 'trg_' || n || '_no_truncate', t);
end $$;

create or replace procedure app.with_updated_at(t regclass) language plpgsql as $$
declare n text := replace(t::text, '.', '_');
begin
  execute format('drop trigger if exists %I on %s', 'trg_' || n || '_touch', t);
  execute format('create trigger %I before update on %s for each row execute function app.touch_updated_at()', 'trg_' || n || '_touch', t);
end $$;

create or replace procedure app.transition_guard(t regclass, p_entity text) language plpgsql as $$
declare n text := replace(t::text, '.', '_');
begin
  execute format('drop trigger if exists %I on %s', 'trg_' || n || '_transition', t);
  execute format('create trigger %I before update on %s for each row execute function app.enforce_transition(%L)', 'trg_' || n || '_transition', t, p_entity);
end $$;
-- =====================================================================
-- 002_tenancy_forms.sql : identity projection, tenancy, RBAC, versioned forms
-- Convention: every tenant-owned parent has UNIQUE (id, workspace_id) so children use
-- COMPOSITE foreign keys (child.parent_id, child.workspace_id). This makes a cross-tenant
-- reference impossible at the database level, independent of application code.
-- =====================================================================
create table users (                       -- Clerk identity projection. Authentication only, never authorization.
  id           uuid primary key default gen_random_uuid(),
  auth_subject text not null unique,       -- Clerk user id
  email        citext not null unique,
  display_name text,
  status       text not null default 'active' check (status in ('active','suspended','deleted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table workspaces (                  -- the tenant boundary
  id          uuid primary key default gen_random_uuid(),
  slug        citext not null unique,
  name        text not null,
  status      text not null default 'active' check (status in ('active','suspended','pending_deletion','deleted')),
  safe_mode   text not null default 'review_sensitive_actions'
              check (safe_mode in ('block_all_external','test_endpoints_only','review_sensitive_actions','off')),
  data_region text not null default 'in',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table roles (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  is_system    boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name),
  unique (id, workspace_id)
);

create table permissions (                 -- global catalog of permission keys
  key         text primary key,
  description text not null
);

create table role_permissions (
  workspace_id   uuid not null,
  role_id        uuid not null,
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key),
  foreign key (role_id, workspace_id) references roles(id, workspace_id) on delete cascade
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id),
  user_id      uuid not null references users(id),
  role_id      uuid not null,
  status       text not null default 'active' check (status in ('invited','active','suspended','left')),
  invited_by   uuid references users(id),
  joined_at    timestamptz,
  left_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (role_id, workspace_id) references roles(id, workspace_id)
);
create index workspace_members_user_idx on workspace_members (user_id, status);

create table workspace_counters (
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  value        bigint not null default 0,
  primary key (workspace_id, name)
);

create or replace function app.next_counter(p_ws uuid, p_name text) returns bigint
language sql as $$
  insert into workspace_counters (workspace_id, name, value) values (p_ws, p_name, 1)
  on conflict (workspace_id, name) do update set value = workspace_counters.value + 1
  returning value
$$;

-- ---- Versioned forms ----
create table form_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  key          text not null,
  name         text not null,
  status       text not null default 'draft' check (status in ('draft','active','archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, key),
  unique (id, workspace_id)
);

create table form_template_versions (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references workspaces(id),
  template_id            uuid not null,
  version_number         integer not null check (version_number > 0),
  status                 text not null default 'draft' check (status in ('draft','published','retired')),
  schema_json            jsonb not null default '{}'::jsonb,
  schema_sha256          bytea,
  privacy_notice_version text,
  published_at           timestamptz,
  published_by           uuid references users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (template_id, version_number),
  unique (id, workspace_id),
  foreign key (template_id, workspace_id) references form_templates(id, workspace_id),
  check (status = 'draft' or (published_at is not null and schema_sha256 is not null))
);

create table form_fields (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  version_id   uuid not null,
  field_key    text not null,
  label        text not null,
  field_type   text not null check (field_type in ('text','textarea','email','phone','date','number','select','multiselect','checkbox','file','signature')),
  required     boolean not null default false,
  sensitivity  text not null default 'internal' check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  validation   jsonb not null default '{}'::jsonb,
  conditional  jsonb,
  position     integer not null default 0,
  unique (version_id, field_key),
  foreign key (version_id, workspace_id) references form_template_versions(id, workspace_id)
);

-- Public/resume links: only a SHA-256 of the random token is stored.
create table respondent_tokens (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id),
  form_version_id uuid not null,
  case_id         uuid,
  purpose         text not null check (purpose in ('public_form','resume')),
  token_hash      bytea not null unique check (octet_length(token_hash) = 32),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (form_version_id, workspace_id) references form_template_versions(id, workspace_id)
);
create index respondent_tokens_expiry_idx on respondent_tokens (expires_at) where revoked_at is null;

-- ---- triggers / RLS ----
call app.with_updated_at('users'); call app.with_updated_at('workspaces');
call app.with_updated_at('workspace_members'); call app.with_updated_at('form_templates');
call app.with_updated_at('form_template_versions');

create trigger trg_ftv_guard before update or delete on form_template_versions
  for each row execute function app.guard_published_version();
create trigger trg_ff_guard before insert or update or delete on form_fields
  for each row execute function app.guard_published_children('form_template_versions', 'version_id');

call app.tenantize('roles'); call app.tenantize('role_permissions'); call app.tenantize('workspace_members');
call app.tenantize('workspace_counters'); call app.tenantize('form_templates');
call app.tenantize('form_template_versions'); call app.tenantize('form_fields'); call app.tenantize('respondent_tokens');

-- workspaces: a session sees only its own workspace
alter table workspaces enable row level security; alter table workspaces force row level security;
create policy workspace_self on workspaces
  using (id = app.current_workspace()) with check (id = app.current_workspace());

-- users: visible only to themselves or to co-members of the current workspace
alter table users enable row level security; alter table users force row level security;
create policy users_select on users for select using (
  id = app.current_user_id()
  or exists (select 1 from workspace_members m where m.user_id = users.id and m.workspace_id = app.current_workspace()));
create policy users_insert on users for insert with check (true);   -- Clerk webhook projection
create policy users_update on users for update
  using (id = app.current_user_id()) with check (id = app.current_user_id());
-- =====================================================================
-- 003_workflow_definitions.sql : versioned workflow graph (definitions are data, not code)
-- MVP ships workflows as versioned JSON (config_json) validated by packages/workflow.
-- workflow_nodes / workflow_edges are populated by the visual editor (Phase 8, gated).
-- =====================================================================
create table workflow_definitions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  key               text not null,
  name              text not null,
  status            text not null default 'active' check (status in ('active','archived')),
  active_version_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, key),
  unique (id, workspace_id)
);

create table workflow_versions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  definition_id  uuid not null,
  version_number integer not null check (version_number > 0),
  status         text not null default 'draft' check (status in ('draft','published','retired')),
  config_json    jsonb not null,
  config_sha256  bytea,
  published_at   timestamptz,
  published_by   uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (definition_id, version_number),
  unique (id, workspace_id),
  foreign key (definition_id, workspace_id) references workflow_definitions(id, workspace_id),
  check (status = 'draft' or (published_at is not null and config_sha256 is not null))
);

alter table workflow_definitions
  add constraint workflow_definitions_active_fk
  foreign key (active_version_id, workspace_id) references workflow_versions(id, workspace_id);

-- the active pointer may only reference a PUBLISHED version (rollback = move the pointer)
create or replace function app.guard_active_version() returns trigger language plpgsql as $$
declare v_status text;
begin
  if new.active_version_id is not null then
    select status into v_status from workflow_versions where id = new.active_version_id;
    if v_status is distinct from 'published' then
      raise exception 'active_version_id must reference a published version (got %)', v_status using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger trg_wd_active before insert or update of active_version_id on workflow_definitions
  for each row execute function app.guard_active_version();

create table workflow_nodes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  version_id   uuid not null,
  node_key     text not null,
  node_type    text not null check (node_type in ('trigger','condition','deterministic_check','ai_result_check',
                 'human_review','timer','approval','team_route','notification','integration','record_update','confirmation')),
  config       jsonb not null default '{}'::jsonb,
  position     jsonb,
  unique (version_id, node_key),
  foreign key (version_id, workspace_id) references workflow_versions(id, workspace_id)
);

create table workflow_edges (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  version_id    uuid not null,
  from_node_key text not null,
  to_node_key   text not null,
  condition     jsonb,
  unique (version_id, from_node_key, to_node_key),
  foreign key (version_id, from_node_key) references workflow_nodes(version_id, node_key),
  foreign key (version_id, to_node_key)   references workflow_nodes(version_id, node_key),
  foreign key (version_id, workspace_id) references workflow_versions(id, workspace_id)
);

create table workflow_dry_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  version_id   uuid not null,
  fixture_ref  text not null,
  status       text not null check (status in ('passed','failed','error')),
  report       jsonb not null,               -- matched conditions, intended actions; never an executable interaction
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  foreign key (version_id, workspace_id) references workflow_versions(id, workspace_id)
);

create table workflow_publish_events (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  definition_id     uuid not null,
  version_id        uuid not null,
  actor_user_id     uuid references users(id),
  action            text not null check (action in ('publish','rollback','retire')),
  prior_status      text,
  new_status        text,
  validation_report jsonb,
  created_at        timestamptz not null default now(),
  foreign key (version_id, workspace_id)    references workflow_versions(id, workspace_id),
  foreign key (definition_id, workspace_id) references workflow_definitions(id, workspace_id)
);

call app.with_updated_at('workflow_definitions'); call app.with_updated_at('workflow_versions');
create trigger trg_wv_guard before update or delete on workflow_versions
  for each row execute function app.guard_published_version();
create trigger trg_wn_guard before insert or update or delete on workflow_nodes
  for each row execute function app.guard_published_children('workflow_versions', 'version_id');
create trigger trg_we_guard before insert or update or delete on workflow_edges
  for each row execute function app.guard_published_children('workflow_versions', 'version_id');
call app.append_only('workflow_publish_events');
call app.append_only('workflow_dry_runs');

call app.tenantize('workflow_definitions'); call app.tenantize('workflow_versions');
call app.tenantize('workflow_nodes'); call app.tenantize('workflow_edges');
call app.tenantize('workflow_dry_runs'); call app.tenantize('workflow_publish_events');
-- =====================================================================
-- 004_cases_documents_ai.sql : cases, documents, evidence, AI control plane,
-- routing, human review, approvals, SLAs
-- =====================================================================
create table cases (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id),
  case_number         bigint not null,
  form_version_id     uuid not null,
  workflow_version_id uuid,
  status              text not null default 'draft' check (status in (
      'draft','submitted','intake_validated','ai_processing','review_queued','review_in_progress',
      'workflow_ready','approval_pending','action_executing','action_blocked','completed','confirmed',
      'closed','rejected','quarantined','cancelled')),
  source              text not null default 'public_link' check (source in ('public_link','internal','api')),
  owner_user_id       uuid references users(id),
  business_key        text,
  sensitivity         text not null default 'sensitive'
                      check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  policy_version      text,
  submitted_at        timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workspace_id, case_number),
  unique (id, workspace_id),
  foreign key (form_version_id, workspace_id)     references form_template_versions(id, workspace_id),
  foreign key (workflow_version_id, workspace_id) references workflow_versions(id, workspace_id)
);
create unique index cases_business_key_uq on cases (workspace_id, business_key) where business_key is not null;
create index cases_workspace_status_idx on cases (workspace_id, status, created_at desc);

alter table respondent_tokens
  add constraint respondent_tokens_case_fk foreign key (case_id, workspace_id) references cases(id, workspace_id);

create table consent_records (              -- DPDP consent/notice evidence (append-only)
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  case_id        uuid not null,
  notice_version text not null,
  purpose        text not null,
  granted        boolean not null,
  granted_at     timestamptz not null default now(),
  ip_hash        bytea,
  created_at     timestamptz not null default now(),
  foreign key (case_id, workspace_id) references cases(id, workspace_id)
);

create table case_participants (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  case_id      uuid not null,
  role         text not null check (role in ('respondent','reviewer','approver','downstream','owner')),
  user_id      uuid references users(id),
  display_name text,
  contact_enc  bytea,                       -- envelope-encrypted contact detail for external respondents
  key_id       text,
  created_at   timestamptz not null default now(),
  foreign key (case_id, workspace_id) references cases(id, workspace_id)
);

create table case_values (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  case_id          uuid not null,
  field_key        text not null,
  revision         integer not null default 1 check (revision > 0),
  sensitivity      text not null default 'internal'
                   check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  value_json       jsonb,
  value_ciphertext bytea,
  key_id           text,
  masked_preview   text,
  source           text not null default 'respondent' check (source in ('respondent','ai_extraction','human_correction','system')),
  confidence       numeric(5,4) check (confidence between 0 and 1),
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  unique (case_id, field_key, revision),
  foreign key (case_id, workspace_id) references cases(id, workspace_id),
  check (value_json is not null or value_ciphertext is not null),
  -- highly sensitive values (Aadhaar, PAN, bank numbers) are NEVER stored as plaintext
  check (sensitivity <> 'highly_sensitive' or (value_json is null and value_ciphertext is not null and key_id is not null))
);

-- Values may be edited freely only while the case is a draft (save/resume). After submission every
-- change is a NEW revision (insert); existing rows are frozen.
create or replace function app.guard_case_values() returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from cases where id = old.case_id;
  if v_status is distinct from 'draft' then
    raise exception 'case_values are frozen after submission; insert a new revision instead' using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger trg_cv_guard before update or delete on case_values for each row execute function app.guard_case_values();

create table retention_policies (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  name              text not null,
  applies_to        text not null check (applies_to in ('documents','evidence','logs','backups','audit','case_values')),
  retain_days       integer not null check (retain_days > 0),
  delete_mode       text not null default 'hard_delete' check (delete_mode in ('hard_delete','crypto_erase','anonymize')),
  legal_hold_allowed boolean not null default true,
  status            text not null default 'active' check (status in ('draft','active','retired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, name),
  unique (id, workspace_id)
);

create table case_documents (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  case_id            uuid not null,
  bucket             text not null,
  object_key         text not null,          -- ws/<workspace_id>/cases/<case_id>/<document_id> (tenant-scoped)
  original_filename  text,                   -- sanitized; may contain personal data -> treated as Sensitive
  mime_type          text not null,
  size_bytes         bigint not null check (size_bytes >= 0),
  sha256             bytea not null check (octet_length(sha256) = 32),
  page_count         integer check (page_count >= 0),
  doc_class          text not null default 'unknown' check (doc_class in
                       ('identity','address','education','employment','bank','tax','photo','other','unknown')),
  status             text not null default 'pending_upload' check (status in
                       ('pending_upload','uploaded','scanning','clean','quarantined','rejected','deleted')),
  sensitivity        text not null default 'sensitive'
                     check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  quarantine_reason  text,
  retention_policy_id uuid,
  retain_until       timestamptz,
  legal_hold         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (bucket, object_key),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id) references cases(id, workspace_id),
  foreign key (retention_policy_id, workspace_id) references retention_policies(id, workspace_id),
  check (status <> 'quarantined' or quarantine_reason is not null)
);
create index case_documents_case_idx on case_documents (case_id, status);
create index case_documents_hash_idx on case_documents (workspace_id, sha256);
create index case_documents_retention_idx on case_documents (retain_until) where deleted_at is null and legal_hold = false;

create table document_scans (              -- file-safety evidence (append-only)
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  document_id       uuid not null,
  scanner           text not null check (scanner in ('clamav','magic_sniff','pdf_sanitizer','image_limits','archive_limits')),
  scanner_version   text not null,
  signature_version text,
  result            text not null check (result in ('clean','infected','suspicious','rejected','error')),
  details           jsonb not null default '{}'::jsonb,
  scanned_at        timestamptz not null default now(),
  foreign key (document_id, workspace_id) references case_documents(id, workspace_id)
);

-- ---------------- AI control plane ----------------
create table ai_model_registry (            -- global (not tenant-owned)
  id              uuid primary key default gen_random_uuid(),
  model_key       text not null,
  version         text not null,
  digest          text not null,
  runtime         text not null,             -- e.g. llama.cpp build / ollama version
  license         text not null,
  source_url      text,
  languages       text[] not null default '{}',
  approval_status text not null default 'candidate' check (approval_status in ('candidate','approved','rejected','retired')),
  approved_by     uuid references users(id),
  approved_at     timestamptz,
  rollback_to     uuid references ai_model_registry(id),
  known_limitations text,
  created_at      timestamptz not null default now(),
  unique (model_key, version),
  check (approval_status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create table ai_benchmark_runs (            -- pre-registered thresholds + measured results (POC gate evidence)
  id                     uuid primary key default gen_random_uuid(),
  model_registry_id      uuid not null references ai_model_registry(id),
  corpus_version         text not null,
  corpus_size            integer not null check (corpus_size > 0),
  concurrency            integer not null check (concurrency > 0),
  resources              jsonb not null,     -- OCPU, RAM, storage of the VM under test
  thresholds_registered  jsonb not null,     -- MUST be recorded before the run
  p50_ms                 integer, p95_ms integer, peak_rss_mb integer, queue_age_max_s integer,
  accuracy               jsonb, calibration jsonb, failure_rate numeric(6,5),
  mixed_load             boolean not null default false,
  passed                 boolean,
  run_by                 uuid references users(id),
  created_at             timestamptz not null default now()
);

create table routing_policies (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id),
  policy_version   text not null,
  status           text not null default 'draft' check (status in ('draft','active','retired')),
  created_by       uuid references users(id),
  activated_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, policy_version),
  unique (id, workspace_id)
);
create table routing_policy_thresholds (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  policy_id     uuid not null,
  doc_class     text not null,
  language      text not null default '*',
  action_risk   text not null check (action_risk in ('low','sensitive','irreversible')),
  min_confidence numeric(5,4) not null check (min_confidence between 0 and 1),
  auto_proceed_allowed boolean not null default false,
  unique (policy_id, doc_class, language, action_risk),
  foreign key (policy_id, workspace_id) references routing_policies(id, workspace_id),
  check (action_risk = 'low' or auto_proceed_allowed = false)   -- sensitive/irreversible can never auto-proceed
);
-- an active policy is frozen (its thresholds cannot be edited); create a new version instead
create or replace function app.guard_active_policy() returns trigger language plpgsql as $$
declare v_status text; v_pid uuid;
begin
  v_pid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'policy_id')::uuid;
  select status into v_status from routing_policies where id = v_pid;
  if v_status in ('active','retired') then
    raise exception 'policy % is % - thresholds are immutable', v_pid, v_status using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger trg_rpt_guard before insert or update or delete on routing_policy_thresholds
  for each row execute function app.guard_active_policy();

create table ai_jobs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id),
  case_id         uuid not null,
  document_id     uuid not null,
  idempotency_key text not null,
  object_sha256   bytea not null check (octet_length(object_sha256) = 32),
  requested_tasks jsonb not null default '["ocr","language","classify","extract","route"]'::jsonb,
  policy_version  text not null,
  status          text not null default 'created' check (status in
                    ('created','queued','claimed','running','completed','review','retrying','failed','dead_letter','cancelled')),
  attempt_count   integer not null default 0,
  max_attempts    integer not null default 4 check (max_attempts between 1 and 10),
  lease_owner     text, lease_until timestamptz, last_heartbeat_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error_class text,
  correlation_id  uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id)     references cases(id, workspace_id),
  foreign key (document_id, workspace_id) references case_documents(id, workspace_id),
  check ((status in ('claimed','running')) = (lease_owner is not null and lease_until is not null))
);
create index ai_jobs_ready_idx on ai_jobs (next_attempt_at, created_at) where status in ('queued','retrying');
create index ai_jobs_lease_idx on ai_jobs (lease_until) where status in ('claimed','running');

create table ai_executions (               -- one row per attempt, including failures
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  ai_job_id              uuid not null,
  attempt_no             integer not null,
  model_registry_id      uuid references ai_model_registry(id),
  engine_version         text, ocr_runtime_version text, prompt_template_version text,
  input_sha256           bytea,
  preprocessing          jsonb,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  duration_ms            integer,
  peak_rss_mb            integer,
  status                 text not null default 'running' check (status in ('running','succeeded','failed','timeout','invalid_output')),
  error_class            text,
  error_detail_redacted  text,
  trace_id               uuid not null default gen_random_uuid(),
  unique (ai_job_id, attempt_no),
  unique (id, workspace_id),
  foreign key (ai_job_id, workspace_id) references ai_jobs(id, workspace_id)
);

create table ai_results (                   -- IMMUTABLE structured model output
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  ai_execution_id       uuid not null unique,
  document_class        text not null check (document_class in
                          ('identity','address','education','employment','bank','tax','photo','other','unknown')),
  detected_language     text not null,
  confidence            numeric(5,4) not null check (confidence between 0 and 1),
  confidence_components jsonb not null,
  sensitivity           text not null check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  routing_recommendation text not null,
  routing_reasons       jsonb not null default '[]'::jsonb,
  schema_version        text not null,
  source_evidence_refs  jsonb not null default '[]'::jsonb,
  raw_output_sha256     bytea,
  created_at            timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (ai_execution_id, workspace_id) references ai_executions(id, workspace_id)
);

create table source_evidence (              -- IMMUTABLE; excerpts only if retention policy allows
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  document_id     uuid not null,
  ai_result_id    uuid not null,
  evidence_type   text not null check (evidence_type in ('ocr_region','text_layer','classification_cue','extraction')),
  page            integer check (page > 0),
  region          jsonb,
  text_sha256     bytea,
  redacted_excerpt text,
  created_at      timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (document_id, workspace_id)  references case_documents(id, workspace_id),
  foreign key (ai_result_id, workspace_id) references ai_results(id, workspace_id)
);
create index source_evidence_doc_idx on source_evidence (document_id, page);

create table document_extractions (         -- IMMUTABLE; never the sole authorization source
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  document_id      uuid not null,
  ai_result_id     uuid not null,
  field_key        text not null,
  sensitivity      text not null default 'sensitive'
                   check (sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  value_json       jsonb,
  value_ciphertext bytea, key_id text,
  masked_preview   text,
  confidence       numeric(5,4) not null check (confidence between 0 and 1),
  evidence_ids     uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  foreign key (document_id, workspace_id)  references case_documents(id, workspace_id),
  foreign key (ai_result_id, workspace_id) references ai_results(id, workspace_id),
  check (value_json is not null or value_ciphertext is not null),
  check (sensitivity <> 'highly_sensitive' or (value_json is null and value_ciphertext is not null and key_id is not null))
);
create index document_extractions_idx on document_extractions (document_id, field_key, created_at desc);

create table document_validation_results ( -- deterministic rule outcomes (append-only)
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  case_id      uuid not null,
  document_id  uuid,
  rule_key     text not null,
  rule_version text not null,
  result       text not null check (result in ('pass','fail','warn','not_applicable')),
  details      jsonb not null default '{}'::jsonb,
  needs_review boolean not null default false,
  created_at   timestamptz not null default now(),
  foreign key (case_id, workspace_id)     references cases(id, workspace_id),
  foreign key (document_id, workspace_id) references case_documents(id, workspace_id)
);
create index dvr_review_idx on document_validation_results (workspace_id, needs_review, created_at desc);

create table routing_decisions (            -- IMMUTABLE. The backend, not the model, makes this decision.
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  case_id        uuid not null,
  document_id    uuid,
  ai_result_id   uuid,
  decision_key   text not null,
  rule_version   text not null,
  policy_version text not null,
  action         text not null,
  route          text not null check (route in ('auto_proceed','human_review','quarantine','dead_letter','reject')),
  reasons        jsonb not null default '[]'::jsonb,
  policy_flags   jsonb not null default '{}'::jsonb,
  thresholds_applied jsonb,
  supersedes_id  uuid references routing_decisions(id),
  created_at     timestamptz not null default now(),
  unique (workspace_id, decision_key),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id)      references cases(id, workspace_id),
  foreign key (document_id, workspace_id)  references case_documents(id, workspace_id),
  foreign key (ai_result_id, workspace_id) references ai_results(id, workspace_id)
);
create index routing_decisions_case_idx on routing_decisions (case_id, created_at desc);

create table review_tasks (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  case_id             uuid not null,
  document_id         uuid,
  routing_decision_id uuid not null,
  reason_codes        text[] not null,
  priority            smallint not null default 3 check (priority between 1 and 5),
  status              text not null default 'open' check (status in ('open','claimed','resolved','rejected','escalated','cancelled')),
  assignee_user_id    uuid references users(id),
  lease_owner         text, lease_until timestamptz,
  due_at              timestamptz,
  resolution          text check (resolution in ('approved','corrected','rework','quarantined','escalated')),
  resolved_by         uuid references users(id),
  resolved_at         timestamptz,
  row_version         integer not null default 1,      -- optimistic locking
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id)             references cases(id, workspace_id),
  foreign key (document_id, workspace_id)         references case_documents(id, workspace_id),
  foreign key (routing_decision_id, workspace_id) references routing_decisions(id, workspace_id),
  check (status <> 'resolved' or (resolution is not null and resolved_by is not null and resolved_at is not null))
);
create index review_tasks_queue_idx on review_tasks (workspace_id, status, priority, due_at) where status in ('open','claimed');

create table human_corrections (            -- IMMUTABLE; original AI result is never overwritten
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  case_id         uuid not null,
  document_id     uuid,
  ai_result_id    uuid,
  review_task_id  uuid,
  actor_user_id   uuid not null references users(id),
  previous_value  jsonb not null,           -- sensitive values appear as {"enc":"...","kid":"..."} envelopes
  corrected_value jsonb not null,
  reason          text not null check (length(btrim(reason)) >= 3),
  approval_context jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  foreign key (case_id, workspace_id)        references cases(id, workspace_id),
  foreign key (document_id, workspace_id)    references case_documents(id, workspace_id),
  foreign key (ai_result_id, workspace_id)   references ai_results(id, workspace_id),
  foreign key (review_task_id, workspace_id) references review_tasks(id, workspace_id)
);

create table approvals (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  case_id           uuid not null,
  workflow_step_key text not null,
  approver_user_id  uuid not null references users(id),
  decision          text not null default 'pending' check (decision in ('pending','approved','rejected','rework_requested','delegated')),
  reason            text,
  decided_at        timestamptz,
  delegated_from    uuid references users(id),
  created_at        timestamptz not null default now(),
  unique (case_id, workflow_step_key, approver_user_id),
  foreign key (case_id, workspace_id) references cases(id, workspace_id),
  check (decision = 'pending' or decided_at is not null),
  check (decision not in ('rejected','rework_requested') or (reason is not null and length(btrim(reason)) >= 3))
);
create index approvals_pending_idx on approvals (workspace_id, approver_user_id) where decision = 'pending';

create table approval_delegations (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  delegator_user_id uuid not null references users(id),
  delegate_user_id  uuid not null references users(id),
  valid_during      tstzrange not null,
  reason            text,
  created_at        timestamptz not null default now(),
  check (delegator_user_id <> delegate_user_id),
  exclude using gist (workspace_id with =, delegator_user_id with =, valid_during with &&)
);

create table sla_policies (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  key            text not null,
  applies_to     text not null check (applies_to in ('review_task','approval','case')),
  target_minutes integer not null check (target_minutes > 0),
  escalation     jsonb not null default '[]'::jsonb,
  status         text not null default 'active' check (status in ('active','retired')),
  created_at     timestamptz not null default now(),
  unique (workspace_id, key),
  unique (id, workspace_id)
);
create table sla_instances (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  policy_id    uuid not null,
  case_id      uuid not null,
  subject_type text not null check (subject_type in ('review_task','approval','case')),
  subject_id   uuid not null,
  started_at   timestamptz not null default now(),
  due_at       timestamptz not null,
  paused_at    timestamptz, breached_at timestamptz, resolved_at timestamptz,
  status       text not null default 'running' check (status in ('running','paused','met','breached')),
  foreign key (policy_id, workspace_id) references sla_policies(id, workspace_id),
  foreign key (case_id, workspace_id)   references cases(id, workspace_id)
);
create index sla_running_idx on sla_instances (due_at) where status = 'running';

-- ---- triggers / RLS ----
call app.with_updated_at('cases'); call app.with_updated_at('case_documents'); call app.with_updated_at('ai_jobs');
call app.with_updated_at('review_tasks'); call app.with_updated_at('retention_policies'); call app.with_updated_at('routing_policies');
create trigger trg_ai_jobs_lease before update on ai_jobs for each row execute function app.clear_lease_when_not_leased();

call app.append_only('consent_records'); call app.append_only('document_scans'); call app.append_only('ai_results');
call app.append_only('source_evidence'); call app.append_only('document_extractions');
call app.append_only('document_validation_results'); call app.append_only('routing_decisions');
call app.append_only('human_corrections');

do $$
declare t text;
begin
  foreach t in array array['cases','consent_records','case_participants','case_values','retention_policies','case_documents',
    'document_scans','routing_policies','routing_policy_thresholds','ai_jobs','ai_executions','ai_results','source_evidence',
    'document_extractions','document_validation_results','routing_decisions','review_tasks','human_corrections','approvals',
    'approval_delegations','sla_policies','sla_instances'] loop
    execute format('call app.tenantize(%L)', t);
  end loop;
end $$;
-- =====================================================================
-- 005_execution_integrations_billing.sql : durable workflow execution, integration
-- interactions/attempts, notifications, webhooks, keys, usage and billing
-- =====================================================================
create table workflow_executions (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id),
  case_id             uuid not null,
  workflow_version_id uuid not null,
  business_key        text not null,
  status              text not null default 'running' check (status in ('running','waiting','completed','failed','cancelled')),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workspace_id, business_key),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id)             references cases(id, workspace_id),
  foreign key (workflow_version_id, workspace_id) references workflow_versions(id, workspace_id)
);

create table workflow_execution_steps (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  execution_id    uuid not null,
  node_key        text not null,
  attempt         integer not null default 1,
  status          text not null default 'pending' check (status in
                    ('pending','claimed','running','succeeded','failed','waiting_approval','waiting_review','retrying','dead_letter','skipped')),
  attempt_count   integer not null default 0,
  max_attempts    integer not null default 4 check (max_attempts between 1 and 10),
  lease_owner     text, lease_until timestamptz, last_heartbeat_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  result          jsonb,
  last_error_class text,
  correlation_id  uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (execution_id, node_key, attempt),
  unique (id, workspace_id),
  foreign key (execution_id, workspace_id) references workflow_executions(id, workspace_id),
  check ((status in ('claimed','running')) = (lease_owner is not null and lease_until is not null))
);
create index wes_ready_idx on workflow_execution_steps (next_attempt_at) where status in ('pending','retrying');
create index wes_lease_idx on workflow_execution_steps (lease_until) where status in ('claimed','running');

create table integration_connections (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  provider       text not null check (provider in ('resend','google_sheets','webhook','razorpay','clerk','r2')),
  name           text not null,
  credential_ref text not null,              -- a REFERENCE to a secret (name/path); never the secret itself
  scopes         text[] not null default '{}',
  status         text not null default 'active' check (status in ('active','disabled','error','revoked')),
  safe_mode_override text check (safe_mode_override in ('block_all_external','test_endpoints_only','review_sensitive_actions','off')),
  health         jsonb not null default '{}'::jsonb,
  last_health_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, provider, name),
  unique (id, workspace_id),
  check (credential_ref !~* '(sk_live|secret_key|password=|BEGIN [A-Z ]*PRIVATE KEY)')   -- cheap guard against pasted secrets
);

create table integration_field_mappings (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  connection_id       uuid not null,
  workflow_version_id uuid not null,
  version             integer not null default 1,
  mapping             jsonb not null,
  status              text not null default 'draft' check (status in ('draft','active','retired')),
  created_at          timestamptz not null default now(),
  unique (connection_id, workflow_version_id, version),
  foreign key (connection_id, workspace_id)       references integration_connections(id, workspace_id),
  foreign key (workflow_version_id, workspace_id) references workflow_versions(id, workspace_id)
);

-- ONE row per intended business effect. The UNIQUE idempotency key is the exactly-once guard.
create table integration_interactions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  case_id           uuid,
  execution_step_id uuid,
  connection_id     uuid,
  provider          text not null,
  action            text not null,
  direction         text not null default 'outbound' check (direction in ('outbound','inbound')),
  idempotency_key   text not null,
  request_sha256    bytea not null check (octet_length(request_sha256) = 32),
  safe_mode         boolean not null default true,
  status            text not null default 'created' check (status in
                      ('created','queued','claimed','in_flight','succeeded','failed_transient','failed_permanent','unknown','review','cancelled')),
  attempt_count     integer not null default 0,
  max_attempts      integer not null default 4 check (max_attempts between 1 and 10),
  lease_owner       text, lease_until timestamptz, last_heartbeat_at timestamptz,
  next_attempt_at   timestamptz not null default now(),
  last_error_class  text,
  correlation_id    uuid not null default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (case_id, workspace_id)            references cases(id, workspace_id),
  foreign key (execution_step_id, workspace_id)  references workflow_execution_steps(id, workspace_id),
  foreign key (connection_id, workspace_id)      references integration_connections(id, workspace_id),
  check ((status in ('claimed','in_flight')) = (lease_owner is not null and lease_until is not null))
);
create index ii_ready_idx on integration_interactions (next_attempt_at) where status in ('queued','failed_transient');
create index ii_lease_idx on integration_interactions (lease_until) where status in ('claimed','in_flight');
create index ii_unknown_idx on integration_interactions (workspace_id, created_at) where status in ('unknown','review');

create table integration_executions (       -- every provider call attempt (append-only)
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  interaction_id uuid not null,
  provider       text not null,
  attempt_no     integer not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  outcome        text not null check (outcome in ('success','transient','permanent','unknown')),
  http_status    integer,
  provider_ref   text,
  redacted_result jsonb,
  error_class    text,
  correlation_id uuid,
  unique (interaction_id, attempt_no),
  foreign key (interaction_id, workspace_id) references integration_interactions(id, workspace_id)
);
create unique index ie_provider_ref_uq on integration_executions (workspace_id, provider, provider_ref) where provider_ref is not null;

-- Effect ledger for ALL side effects (integration or internal). Guards exactly-once at the workflow-step level.
create table external_action_attempts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  execution_step_id uuid not null,
  interaction_id  uuid,
  action          text not null,
  idempotency_key text not null,
  request_sha256  bytea,
  effect_status   text not null default 'pending' check (effect_status in ('pending','applied','unknown','failed','compensated')),
  replay_of       uuid references external_action_attempts(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (execution_step_id, workspace_id) references workflow_execution_steps(id, workspace_id),
  foreign key (interaction_id, workspace_id)     references integration_interactions(id, workspace_id)
);

create table notifications (                -- delivery history; NEVER proof that a business action succeeded
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id),
  case_id             uuid,
  interaction_id      uuid,
  channel             text not null default 'email' check (channel in ('email')),
  recipient           citext not null,
  template_key        text not null,
  status              text not null default 'queued' check (status in ('queued','sent','delivered','bounced','complained','failed')),
  provider_message_id text,
  attempt_count       integer not null default 0,
  next_attempt_at     timestamptz,
  last_error_class    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (case_id, workspace_id)        references cases(id, workspace_id),
  foreign key (interaction_id, workspace_id) references integration_interactions(id, workspace_id)
);
create index notifications_queue_idx on notifications (next_attempt_at) where status = 'queued';

create table webhook_endpoints (            -- customer-configured OUTBOUND endpoints
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  url          text not null check (url ~* '^https://'),
  secret_ref   text not null,
  events       text[] not null default '{}',
  status       text not null default 'active' check (status in ('active','disabled')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table inbound_webhook_events (       -- Clerk / Resend / Razorpay callbacks: dedupe + replay protection (platform-level)
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null check (provider in ('clerk','resend','razorpay','google','custom')),
  provider_event_id  text not null,
  workspace_id       uuid references workspaces(id),
  signature_valid    boolean not null,
  payload_sha256     bytea not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  status             text not null default 'received' check (status in ('received','verified','processed','rejected','duplicate')),
  unique (provider, provider_event_id)
);

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  key_prefix   text not null,
  key_hash     bytea not null unique check (octet_length(key_hash) = 32),   -- SHA-256 of the key; shown once at creation
  scopes       text[] not null default '{}',
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);

create table service_credentials (          -- inventory of secrets (references only) for rotation tracking
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid references workspaces(id),          -- NULL = platform-level secret
  name             text not null,
  provider         text not null,
  secret_ref       text not null,
  owner            text not null,
  rotation_due_at  timestamptz not null,
  last_rotated_at  timestamptz,
  status           text not null default 'active' check (status in ('active','rotating','revoked')),
  created_at       timestamptz not null default now(),
  unique (name)
);

-- ---- usage & billing ----
create table billing_plans (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique,
  name            text not null,
  price_inr_month integer not null check (price_inr_month >= 0),
  limits          jsonb not null,
  active          boolean not null default true
);
create table subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id),
  plan_id                  uuid not null references billing_plans(id),
  status                   text not null default 'manual' check (status in ('trialing','active','past_due','cancelled','manual')),
  provider                 text not null default 'manual' check (provider in ('manual','razorpay','stripe')),
  provider_subscription_id text,
  current_period_start     timestamptz, current_period_end timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index subscriptions_active_uq on subscriptions (workspace_id) where status in ('trialing','active','past_due','manual');
create unique index subscriptions_provider_uq on subscriptions (provider, provider_subscription_id) where provider_subscription_id is not null;

create table usage_events (                 -- idempotent metering source of truth
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  event_key    text not null,
  metric       text not null check (metric in ('cases','documents','ai_executions','storage_mb','notifications','integration_calls')),
  quantity     bigint not null check (quantity > 0),
  occurred_at  timestamptz not null default now(),
  unique (workspace_id, event_key)
);
create table usage_counters (
  workspace_id uuid not null references workspaces(id),
  period_start date not null,
  metric       text not null,
  value        bigint not null default 0,
  primary key (workspace_id, period_start, metric)
);
create or replace function app.record_usage(p_ws uuid, p_key text, p_metric text, p_qty bigint) returns boolean
language plpgsql as $$
declare v_inserted int;
begin
  insert into usage_events (workspace_id, event_key, metric, quantity) values (p_ws, p_key, p_metric, p_qty)
  on conflict (workspace_id, event_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return false; end if;     -- duplicate event: counted once
  insert into usage_counters (workspace_id, period_start, metric, value)
  values (p_ws, date_trunc('month', now())::date, p_metric, p_qty)
  on conflict (workspace_id, period_start, metric) do update set value = usage_counters.value + excluded.value;
  return true;
end $$;

-- ---- triggers / RLS ----
call app.with_updated_at('workflow_executions'); call app.with_updated_at('workflow_execution_steps');
call app.with_updated_at('integration_connections'); call app.with_updated_at('integration_interactions');
call app.with_updated_at('external_action_attempts'); call app.with_updated_at('notifications'); call app.with_updated_at('subscriptions');
create trigger trg_wes_lease before update on workflow_execution_steps for each row execute function app.clear_lease_when_not_leased();
create trigger trg_ii_lease  before update on integration_interactions for each row execute function app.clear_lease_when_not_leased();
call app.append_only('integration_executions');

do $$
declare t text;
begin
  foreach t in array array['workflow_executions','workflow_execution_steps','integration_connections','integration_field_mappings',
    'integration_interactions','integration_executions','external_action_attempts','notifications','webhook_endpoints',
    'api_keys','subscriptions','usage_events','usage_counters'] loop
    execute format('call app.tenantize(%L)', t);
  end loop;
end $$;
-- service_credentials: platform rows (workspace_id NULL) are ops-only; tenant rows follow tenant isolation
alter table service_credentials enable row level security; alter table service_credentials force row level security;
create policy sc_tenant on service_credentials using (workspace_id = app.current_workspace())
  with check (workspace_id = app.current_workspace());
-- inbound_webhook_events: platform-level; only definer functions / ops role read it
alter table inbound_webhook_events enable row level security; alter table inbound_webhook_events force row level security;
-- =====================================================================
-- 006_governance_audit_ops.sql : retention/deletion/legal hold, incidents, tamper-evident audit chain,
-- dead letters, state machines, safety guards, privileged queue functions, seeds, grants
-- =====================================================================
create table legal_holds (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  subject_type text not null check (subject_type in ('case','document','workspace')),
  subject_id   uuid not null,
  reason       text not null,
  placed_by    uuid references users(id),
  placed_at    timestamptz not null default now(),
  released_at  timestamptz
);
create index legal_holds_active_idx on legal_holds (workspace_id, subject_type, subject_id) where released_at is null;

create table deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  subject_type text not null check (subject_type in ('case','document','respondent','workspace')),
  subject_id   uuid not null,
  requested_by uuid references users(id),
  reason       text,
  status       text not null default 'requested' check (status in
                 ('requested','approved','in_progress','completed','rejected','blocked_legal_hold')),
  requested_at timestamptz not null default now(),
  sla_due_at   timestamptz,
  completed_at timestamptz,
  evidence     jsonb not null default '{}'::jsonb,     -- object keys removed, hashes, timestamps: proof of deletion
  check (status <> 'completed' or completed_at is not null)
);

create table incident_records (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspaces(id),        -- NULL = platform-wide incident
  severity      text not null check (severity in ('sev1','sev2','sev3','sev4')),
  title         text not null,
  status        text not null default 'open' check (status in ('open','contained','recovering','closed')),
  scope         jsonb not null default '{"tenants":"unknown","objects":"unknown"}'::jsonb,
  actions       jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  notifications jsonb not null default '[]'::jsonb,
  opened_by     uuid references users(id),
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  check (status <> 'closed' or closed_at is not null)
);

create table dead_letter_items (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id),
  source_type           text not null check (source_type in ('ai_job','workflow_step','integration_interaction','notification')),
  source_id             uuid not null,
  failure_class         text,
  attempts              integer,
  redacted_diagnosis    text,
  status                text not null default 'open' check (status in ('open','diagnosed','replay_authorized','replayed','closed')),
  replay_authorized_by  uuid references users(id),
  replay_authorized_at  timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (status not in ('replay_authorized','replayed') or (replay_authorized_by is not null and replay_authorized_at is not null))
);
create index dead_letter_open_idx on dead_letter_items (workspace_id, status) where status in ('open','diagnosed');

-- ---------------------------------------------------------------------
-- Tamper-evident audit log: per-workspace SHA-256 hash chain
-- ---------------------------------------------------------------------
create table audit_events (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  chain_seq      bigint not null,
  occurred_at    timestamptz not null default now(),
  actor_type     text not null check (actor_type in ('user','system','ai','integration','worker','provider')),
  actor_id       text,
  action         text not null,
  object_type    text not null,
  object_id      text,
  correlation_id uuid,
  reason         text,
  payload        jsonb not null default '{}'::jsonb,    -- REDACTED metadata only: never raw document text or secrets
  prev_hash      bytea,
  event_hash     bytea not null,
  unique (workspace_id, chain_seq)
);
create index audit_events_object_idx on audit_events (workspace_id, object_type, object_id, occurred_at desc);
create index audit_events_corr_idx   on audit_events (workspace_id, correlation_id);
create index audit_events_time_idx   on audit_events (workspace_id, occurred_at desc);

create or replace function app.audit_hash(e audit_events, p_prev bytea) returns bytea
language sql immutable as $$
  select digest(
      coalesce(encode(p_prev, 'hex'), 'GENESIS') || '|' || e.workspace_id::text || '|' || e.chain_seq::text || '|' ||
      to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
      e.actor_type || '|' || coalesce(e.actor_id, '') || '|' || e.action || '|' || e.object_type || '|' ||
      coalesce(e.object_id, '') || '|' || coalesce(e.correlation_id::text, '') || '|' || coalesce(e.reason, '') || '|' ||
      e.payload::text, 'sha256')
$$;

create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare v_prev bytea; v_seq bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 42));   -- serialize per workspace
  select event_hash, chain_seq into v_prev, v_seq
    from audit_events where workspace_id = new.workspace_id order by chain_seq desc limit 1;
  new.chain_seq  := coalesce(v_seq, 0) + 1;
  new.prev_hash  := v_prev;
  new.event_hash := app.audit_hash(new, v_prev);
  return new;
end $$;
create trigger trg_audit_chain before insert on audit_events for each row execute function app.audit_chain();

create or replace function app.verify_audit_chain(p_ws uuid)
returns table (ok boolean, first_bad_seq bigint, checked bigint) language plpgsql as $$
declare r audit_events; v_prev bytea := null; v_expected bigint := 1; v_n bigint := 0;
begin
  for r in select * from audit_events where workspace_id = p_ws order by chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_expected or r.prev_hash is distinct from v_prev or r.event_hash <> app.audit_hash(r, v_prev) then
      return query select false, r.chain_seq, v_n; return;
    end if;
    v_prev := r.event_hash; v_expected := v_expected + 1;
  end loop;
  return query select true, null::bigint, v_n;
end $$;

create or replace function app.audit(p_action text, p_object_type text, p_object_id text,
    p_reason text default null, p_payload jsonb default '{}'::jsonb,
    p_actor_type text default 'system', p_actor_id text default null, p_correlation uuid default null)
returns uuid language sql as $$
  insert into audit_events (workspace_id, actor_type, actor_id, action, object_type, object_id, correlation_id, reason, payload, event_hash)
  values (app.current_workspace(), p_actor_type, p_actor_id, p_action, p_object_type, p_object_id, p_correlation, p_reason, p_payload, '\x00')
  returning id
$$;

-- ---------------------------------------------------------------------
-- Safety guards that hold even if application code is wrong
-- ---------------------------------------------------------------------
alter table approvals add column round integer not null default 1 check (round > 0);
alter table approvals drop constraint approvals_case_id_workflow_step_key_approver_user_id_key;
alter table approvals add constraint approvals_round_uq unique (case_id, workflow_step_key, approver_user_id, round);

create or replace function app.approval_final() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'approvals cannot be deleted' using errcode = '55000'; end if;
  if old.decision <> 'pending' then raise exception 'a decided approval is final; open a new round' using errcode = '55000'; end if;
  return new;
end $$;
create trigger trg_approvals_final before update or delete on approvals for each row execute function app.approval_final();

-- INVARIANT: a sensitive case cannot enter action_executing without a complete, approved current round.
create or replace function app.guard_case_action() returns trigger language plpgsql as $$
declare v_round integer;
begin
  if new.status = 'action_executing' and old.status is distinct from 'action_executing'
     and new.sensitivity in ('sensitive','highly_sensitive') then
    select max(round) into v_round from approvals where case_id = new.id;
    if v_round is null
       or not exists (select 1 from approvals where case_id = new.id and round = v_round and decision = 'approved')
       or exists (select 1 from approvals where case_id = new.id and round = v_round and decision in ('pending','rejected','rework_requested')) then
      raise exception 'case % cannot execute actions without a complete approval', new.id using errcode = '23514';
    end if;
  end if;
  if new.status in ('completed','confirmed','closed') and old.status is distinct from new.status then
    new.closed_at := case when new.status = 'closed' then now() else new.closed_at end;
  end if;
  return new;
end $$;
create trigger trg_cases_action_guard before update on cases for each row execute function app.guard_case_action();

-- ---------------------------------------------------------------------
-- State machines
-- ---------------------------------------------------------------------
insert into app.state_transitions (entity, from_status, to_status) values
 -- cases
 ('case','draft','submitted'),('case','draft','cancelled'),
 ('case','submitted','intake_validated'),('case','submitted','quarantined'),('case','submitted','rejected'),('case','submitted','cancelled'),
 ('case','intake_validated','ai_processing'),('case','intake_validated','review_queued'),('case','intake_validated','workflow_ready'),
 ('case','intake_validated','quarantined'),('case','intake_validated','cancelled'),
 ('case','ai_processing','review_queued'),('case','ai_processing','workflow_ready'),('case','ai_processing','quarantined'),('case','ai_processing','cancelled'),
 ('case','review_queued','review_in_progress'),('case','review_queued','quarantined'),('case','review_queued','cancelled'),
 ('case','review_in_progress','workflow_ready'),('case','review_in_progress','review_queued'),
 ('case','review_in_progress','rejected'),('case','review_in_progress','quarantined'),
 ('case','workflow_ready','approval_pending'),('case','workflow_ready','action_executing'),('case','workflow_ready','cancelled'),
 ('case','approval_pending','action_executing'),('case','approval_pending','rejected'),
 ('case','approval_pending','review_queued'),('case','approval_pending','cancelled'),
 ('case','action_executing','completed'),('case','action_executing','action_blocked'),
 ('case','action_blocked','action_executing'),('case','action_blocked','review_queued'),('case','action_blocked','cancelled'),
 ('case','completed','confirmed'),('case','confirmed','closed'),
 ('case','rejected','review_queued'),('case','rejected','closed'),
 ('case','quarantined','review_queued'),('case','quarantined','closed'),('case','quarantined','cancelled'),
 -- AI jobs
 ('ai_job','created','queued'),('ai_job','queued','claimed'),('ai_job','queued','cancelled'),
 ('ai_job','retrying','claimed'),('ai_job','retrying','cancelled'),
 ('ai_job','claimed','running'),('ai_job','claimed','queued'),('ai_job','claimed','retrying'),('ai_job','claimed','dead_letter'),
 ('ai_job','running','completed'),('ai_job','running','review'),('ai_job','running','retrying'),
 ('ai_job','running','failed'),('ai_job','running','dead_letter'),
 ('ai_job','failed','review'),('ai_job','failed','dead_letter'),
 ('ai_job','dead_letter','queued'),('ai_job','review','completed'),
 -- workflow steps
 ('wf_step','pending','claimed'),('wf_step','pending','skipped'),('wf_step','retrying','claimed'),
 ('wf_step','claimed','running'),('wf_step','claimed','pending'),('wf_step','claimed','retrying'),('wf_step','claimed','dead_letter'),
 ('wf_step','running','succeeded'),('wf_step','running','failed'),('wf_step','running','retrying'),
 ('wf_step','running','waiting_approval'),('wf_step','running','waiting_review'),('wf_step','running','dead_letter'),
 ('wf_step','waiting_approval','succeeded'),('wf_step','waiting_approval','failed'),('wf_step','waiting_approval','skipped'),
 ('wf_step','waiting_review','succeeded'),('wf_step','waiting_review','failed'),('wf_step','waiting_review','skipped'),
 ('wf_step','failed','dead_letter'),('wf_step','dead_letter','pending'),
 -- integration interactions (unknown NEVER goes straight back to queued: a human/status-lookup decision is required)
 ('interaction','created','queued'),('interaction','queued','claimed'),('interaction','queued','cancelled'),
 ('interaction','claimed','in_flight'),('interaction','claimed','queued'),('interaction','claimed','failed_permanent'),
 ('interaction','in_flight','succeeded'),('interaction','in_flight','failed_transient'),
 ('interaction','in_flight','failed_permanent'),('interaction','in_flight','unknown'),
 ('interaction','failed_transient','queued'),('interaction','failed_transient','failed_permanent'),
 ('interaction','unknown','succeeded'),('interaction','unknown','review'),
 ('interaction','review','queued'),('interaction','review','succeeded'),('interaction','review','failed_permanent'),('interaction','review','cancelled'),
 ('interaction','failed_permanent','review'),('interaction','failed_permanent','cancelled'),
 -- review tasks
 ('review_task','open','claimed'),('review_task','open','cancelled'),('review_task','open','escalated'),
 ('review_task','claimed','open'),('review_task','claimed','resolved'),('review_task','claimed','rejected'),
 ('review_task','claimed','escalated'),('review_task','claimed','cancelled'),('review_task','escalated','open');

call app.transition_guard('cases','case');
call app.transition_guard('ai_jobs','ai_job');
call app.transition_guard('workflow_execution_steps','wf_step');
call app.transition_guard('integration_interactions','interaction');
call app.transition_guard('review_tasks','review_task');

-- ---------------------------------------------------------------------
-- Tenant isolation + append-only for this module
-- ---------------------------------------------------------------------
call app.with_updated_at('dead_letter_items');
call app.append_only('audit_events');
do $$
declare t text;
begin
  foreach t in array array['legal_holds','deletion_requests','dead_letter_items','audit_events'] loop
    execute format('call app.tenantize(%L)', t);
  end loop;
end $$;
alter table incident_records enable row level security; alter table incident_records force row level security;
create policy ir_tenant on incident_records using (workspace_id = app.current_workspace())
  with check (workspace_id = app.current_workspace());
create policy ir_ops on incident_records to formiva_ops using (true) with check (true);
create policy sc_ops  on service_credentials to formiva_ops using (true) with check (true);
create policy iwe_all on inbound_webhook_events to formiva_app, formiva_worker, formiva_ops using (true) with check (true);

-- ---------------------------------------------------------------------
-- Seeds: permission catalog, billing plan hypotheses
-- ---------------------------------------------------------------------
insert into permissions (key, description) values
 ('workspace.manage','Edit workspace settings'),('member.manage','Invite/remove members and assign roles'),
 ('form.edit','Edit draft forms'),('form.publish','Publish a form version'),
 ('workflow.edit','Edit draft workflows'),('workflow.publish','Publish or roll back a workflow version'),
 ('case.read','View cases (sensitive values masked)'),('case.create','Create cases internally'),
 ('case.review','Claim and resolve review tasks'),('case.correct','Record human corrections'),
 ('case.approve','Approve, reject, delegate, request rework'),('case.reassign','Reassign review tasks'),
 ('document.read_sensitive','View unmasked sensitive values and documents'),
 ('integration.manage','Manage connectors and field mappings'),('integration.replay','Replay integration interactions'),
 ('deadletter.replay','Authorize replay of dead letters'),('safe_mode.manage','Change safe mode'),
 ('audit.read','Read audit trail'),('audit.export','Export audit trail'),
 ('billing.manage','Manage plan and billing'),('retention.manage','Manage retention policies and legal holds'),
 ('deletion.request','Request deletion'),('deletion.approve','Approve deletion'),
 ('incident.manage','Open and manage incidents'),('apikey.manage','Manage API keys'),('analytics.read','View analytics');

insert into billing_plans (key, name, price_inr_month, limits) values
 ('free','Free sandbox',0,'{"placeholder":true,"sensitive_production_use":false,"workflows":1,"cases_per_month":25,"seats":2}'),
 ('starter','Starter SMB',999,'{"placeholder":true,"workflows":1,"cases_per_month":100,"seats":5}'),
 ('pro','Vertical Pro',2999,'{"placeholder":true,"workflows":3,"cases_per_month":400,"seats":15}'),
 ('governance','Governance/Scale',7999,'{"placeholder":true,"workflows":10,"cases_per_month":2000,"seats":50}');

-- Creates the default system roles + owner membership. Call inside a transaction after app.set_context().
create or replace function app.bootstrap_workspace(p_ws uuid, p_owner uuid) returns void language plpgsql as $$
declare d record; v_role uuid;
begin
  if p_ws is distinct from app.current_workspace() then raise exception 'context workspace mismatch'; end if;
  for d in select * from (values
      ('owner',              null::text[]),
      ('admin',              array['workspace.manage','member.manage','form.edit','form.publish','workflow.edit','workflow.publish','case.read','case.create','case.reassign','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','audit.read','retention.manage','deletion.request','apikey.manage','analytics.read']),
      ('reviewer',           array['case.read','case.review','case.correct','document.read_sensitive','analytics.read']),
      ('approver',           array['case.read','case.approve']),
      ('integration_operator',array['case.read','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','analytics.read']),
      ('auditor',            array['case.read','audit.read','audit.export','analytics.read']),
      ('viewer',             array['case.read','analytics.read'])
    ) as t(name, perms) loop
    insert into roles (workspace_id, name, is_system) values (p_ws, d.name, true) returning id into v_role;
    insert into role_permissions (workspace_id, role_id, permission_key)
      select p_ws, v_role, k from unnest(coalesce(d.perms, (select array_agg(key) from permissions))) k;
  end loop;
  insert into workspace_members (workspace_id, user_id, role_id, status, joined_at)
    select p_ws, p_owner, id, 'active', now() from roles where workspace_id = p_ws and name = 'owner';
  perform app.audit('workspace.bootstrapped','workspace', p_ws::text, null, '{}'::jsonb, 'user', p_owner::text);
end $$;

-- ---------------------------------------------------------------------
-- PRIVILEGED (SECURITY DEFINER) functions - owned by formiva_definer (BYPASSRLS)
-- Workers claim across tenants, so the claim must bypass RLS; everything else stays under RLS.
-- ---------------------------------------------------------------------
create or replace function ops.claim_next_ai_job(p_worker text, p_lease_seconds integer default 300)
returns table (job_id uuid, ws_id uuid, case_id uuid, document_id uuid, idempotency_key text, attempts integer, correlation_id uuid)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  select j.id into v_id from ai_jobs j
   where j.status in ('queued','retrying') and j.next_attempt_at <= now()
   order by j.next_attempt_at, j.created_at
   for update skip locked limit 1;
  if v_id is null then return; end if;
  return query
    update ai_jobs j set status = 'claimed', lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           last_heartbeat_at = now(), attempt_count = j.attempt_count + 1
     where j.id = v_id
    returning j.id, j.workspace_id, j.case_id, j.document_id, j.idempotency_key, j.attempt_count, j.correlation_id;
end $$;

create or replace function ops.claim_next_step(p_worker text, p_lease_seconds integer default 300)
returns table (step_id uuid, ws_id uuid, execution_id uuid, node_key text, attempts integer, correlation_id uuid)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  select s.id into v_id from workflow_execution_steps s
   where s.status in ('pending','retrying') and s.next_attempt_at <= now()
   order by s.next_attempt_at, s.created_at
   for update skip locked limit 1;
  if v_id is null then return; end if;
  return query
    update workflow_execution_steps s set status = 'claimed', lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           last_heartbeat_at = now(), attempt_count = s.attempt_count + 1
     where s.id = v_id
    returning s.id, s.workspace_id, s.execution_id, s.node_key, s.attempt_count, s.correlation_id;
end $$;

create or replace function ops.claim_next_interaction(p_worker text, p_lease_seconds integer default 120)
returns table (interaction_id uuid, ws_id uuid, provider text, action text, idempotency_key text, attempts integer, correlation_id uuid)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  select i.id into v_id from integration_interactions i
   where i.status = 'queued' and i.next_attempt_at <= now()
   order by i.next_attempt_at, i.created_at
   for update skip locked limit 1;
  if v_id is null then return; end if;
  return query
    update integration_interactions i set status = 'claimed', lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           last_heartbeat_at = now(), attempt_count = i.attempt_count + 1
     where i.id = v_id
    returning i.id, i.workspace_id, i.provider, i.action, i.idempotency_key, i.attempt_count, i.correlation_id;
end $$;

-- Reaper. Run every minute from the scheduler. NEVER blindly retries a possibly-sent external call:
-- a lease that expires while an interaction is 'in_flight' becomes 'unknown' (status lookup / human review).
create or replace function ops.requeue_expired_leases()
returns table (queue text, requeued integer, dead_lettered integer, unknown_outcomes integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n_re integer; n_dl integer; n_un integer;
begin
  -- AI jobs
  with x as (
    update ai_jobs set
       status = case when attempt_count >= max_attempts then 'dead_letter' else 'retrying' end,
       next_attempt_at = now() + make_interval(secs => least(30 * power(2, attempt_count), 3600)),
       last_error_class = 'lease_expired'
     where status in ('claimed','running') and lease_until < now()
    returning id, workspace_id, status, attempt_count),
  dl as (insert into dead_letter_items (workspace_id, source_type, source_id, failure_class, attempts)
         select workspace_id, 'ai_job', id, 'lease_expired', attempt_count from x where status = 'dead_letter' returning 1)
  select count(*) filter (where status = 'retrying'), (select count(*) from dl) into n_re, n_dl from x;
  queue := 'ai_jobs'; requeued := n_re; dead_lettered := n_dl; unknown_outcomes := 0; return next;

  -- Workflow steps
  with x as (
    update workflow_execution_steps set
       status = case when attempt_count >= max_attempts then 'dead_letter' else 'retrying' end,
       next_attempt_at = now() + make_interval(secs => least(30 * power(2, attempt_count), 3600)),
       last_error_class = 'lease_expired'
     where status in ('claimed','running') and lease_until < now()
    returning id, workspace_id, status, attempt_count),
  dl as (insert into dead_letter_items (workspace_id, source_type, source_id, failure_class, attempts)
         select workspace_id, 'workflow_step', id, 'lease_expired', attempt_count from x where status = 'dead_letter' returning 1)
  select count(*) filter (where status = 'retrying'), (select count(*) from dl) into n_re, n_dl from x;
  queue := 'workflow_steps'; requeued := n_re; dead_lettered := n_dl; unknown_outcomes := 0; return next;

  -- Integration interactions: claimed (call not yet sent) is safe to requeue; in_flight is NOT.
  with c as (
    update integration_interactions set
       status = case when attempt_count >= max_attempts then 'failed_permanent' else 'queued' end,
       next_attempt_at = now() + make_interval(secs => least(30 * power(2, attempt_count), 3600)),
       last_error_class = 'lease_expired_before_call'
     where status = 'claimed' and lease_until < now()
    returning id, workspace_id, status, attempt_count),
  dl as (insert into dead_letter_items (workspace_id, source_type, source_id, failure_class, attempts)
         select workspace_id, 'integration_interaction', id, 'lease_expired_before_call', attempt_count from c where status = 'failed_permanent' returning 1)
  select count(*) filter (where status = 'queued'), (select count(*) from dl) into n_re, n_dl from c;
  with u as (
    update integration_interactions set status = 'unknown', last_error_class = 'lease_expired_in_flight'
     where status = 'in_flight' and lease_until < now() returning 1)
  select count(*) into n_un from u;
  queue := 'integrations'; requeued := n_re; dead_lettered := n_dl; unknown_outcomes := n_un; return next;
end $$;

create or replace view ops.queue_health as
  select 'ai_jobs'::text as queue,
         count(*) filter (where status in ('queued','retrying')) as ready,
         count(*) filter (where status in ('claimed','running')) as leased,
         count(*) filter (where status = 'dead_letter') as dead_letters,
         count(*) filter (where status in ('claimed','running') and lease_until < now()) as expired_leases,
         0::bigint as unknown_outcomes,
         coalesce(extract(epoch from now() - min(next_attempt_at) filter (where status in ('queued','retrying') and next_attempt_at <= now()))::bigint, 0) as oldest_ready_age_s
    from ai_jobs
  union all
  select 'workflow_steps', count(*) filter (where status in ('pending','retrying')), count(*) filter (where status in ('claimed','running')),
         count(*) filter (where status = 'dead_letter'), count(*) filter (where status in ('claimed','running') and lease_until < now()), 0,
         coalesce(extract(epoch from now() - min(next_attempt_at) filter (where status in ('pending','retrying') and next_attempt_at <= now()))::bigint, 0)
    from workflow_execution_steps
  union all
  select 'integrations', count(*) filter (where status = 'queued'), count(*) filter (where status in ('claimed','in_flight')),
         count(*) filter (where status = 'failed_permanent'), count(*) filter (where status in ('claimed','in_flight') and lease_until < now()),
         count(*) filter (where status in ('unknown','review')),
         coalesce(extract(epoch from now() - min(next_attempt_at) filter (where status = 'queued' and next_attempt_at <= now()))::bigint, 0)
    from integration_interactions
  union all
  select 'review_tasks', count(*) filter (where status = 'open'), count(*) filter (where status = 'claimed'), 0, 0, 0,
         coalesce(extract(epoch from now() - min(created_at) filter (where status = 'open'))::bigint, 0)
    from review_tasks;

-- Login helper: which workspaces + permissions does this Clerk user have? (runs before a workspace context exists)
create or replace function ops.workspaces_for_user(p_auth_subject text)
returns table (ws_id uuid, slug citext, role_name text, permissions text[])
language sql security definer stable set search_path = pg_catalog, public as $$
  select w.id, w.slug, r.name,
         array(select rp.permission_key from role_permissions rp where rp.role_id = r.id order by 1)
    from users u
    join workspace_members m on m.user_id = u.id and m.status = 'active'
    join workspaces w on w.id = m.workspace_id and w.status = 'active'
    join roles r on r.id = m.role_id and r.workspace_id = m.workspace_id
   where u.auth_subject = p_auth_subject
$$;

-- Public respondent link resolution (before any workspace context exists). Hash in, scope out.
create or replace function ops.resolve_respondent_token(p_token_hash bytea)
returns table (ws_id uuid, form_version_id uuid, case_id uuid, purpose text)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return query
    update respondent_tokens t set last_used_at = now()
     where t.token_hash = p_token_hash and t.revoked_at is null and t.expires_at > now()
    returning t.workspace_id, t.form_version_id, t.case_id, t.purpose;
end $$;

-- ---------------------------------------------------------------------
-- Ownership + grants (least privilege)
-- ---------------------------------------------------------------------
grant usage on schema public, app, ops to formiva_definer;
grant create on schema ops to formiva_definer;
grant select, update on ai_jobs, workflow_execution_steps, integration_interactions to formiva_definer;
grant select on review_tasks, workspaces, users, workspace_members, roles, role_permissions to formiva_definer;
grant select, update on respondent_tokens to formiva_definer;
grant insert, select on dead_letter_items to formiva_definer;

alter function ops.claim_next_ai_job(text, integer)        owner to formiva_definer;
alter function ops.claim_next_step(text, integer)          owner to formiva_definer;
alter function ops.claim_next_interaction(text, integer)   owner to formiva_definer;
alter function ops.requeue_expired_leases()                owner to formiva_definer;
alter function ops.workspaces_for_user(text)               owner to formiva_definer;
alter function ops.resolve_respondent_token(bytea)         owner to formiva_definer;
alter view ops.queue_health                                owner to formiva_definer;

revoke all on all tables in schema public from public;
revoke all on all functions in schema ops from public;
revoke create on schema public from public;
grant usage on schema public, app, ops to formiva_app, formiva_worker, formiva_readonly, formiva_ops;
grant select on app.state_transitions to formiva_app, formiva_worker, formiva_definer, formiva_ops, formiva_readonly;

grant select on all tables in schema public to formiva_readonly;
grant select, insert, update on all tables in schema public to formiva_app, formiva_worker;
grant delete on respondent_tokens, case_values, form_fields, workflow_nodes, workflow_edges, role_permissions,
               approval_delegations, webhook_endpoints to formiva_app;

-- global catalogs are read-only to runtime roles; only the ops role (model promotion, plan changes) may write
revoke insert, update on permissions, billing_plans, ai_model_registry, ai_benchmark_runs from formiva_app, formiva_worker;
grant select, insert, update on permissions, billing_plans, ai_model_registry, ai_benchmark_runs, incident_records, service_credentials to formiva_ops;

-- append-only tables: no UPDATE/DELETE/TRUNCATE at the privilege level either (triggers are the second lock)
revoke update, delete, truncate on audit_events, ai_results, source_evidence, document_extractions,
       document_validation_results, routing_decisions, human_corrections, consent_records, document_scans,
       integration_executions, workflow_publish_events, workflow_dry_runs from formiva_app, formiva_worker;
revoke delete, truncate on all tables in schema public from formiva_worker;

grant execute on function ops.claim_next_ai_job(text, integer), ops.claim_next_step(text, integer),
      ops.claim_next_interaction(text, integer), ops.requeue_expired_leases() to formiva_worker;
grant execute on function ops.workspaces_for_user(text), ops.resolve_respondent_token(bytea) to formiva_app;
grant select on ops.queue_health to formiva_ops, formiva_worker;
-- =====================================================================
-- 007_government_documents.sql : government-issued document policy
--  * catalog of document subtypes (which are government-issued, default sensitivity)
--  * per-workspace collection policy (what the employer chooses to collect, why, how)
--  * enforcement: fail closed when a government document has no policy; ID documents are always
--    highly sensitive; Aadhaar policies must require a masked copy; purpose is mandatory
-- Formiva READS documents and extracts fields. It does NOT verify authenticity against government
-- databases (UIDAI, NSDL/Protean, DigiLocker, Passport Seva). Format checks are offline only.
-- =====================================================================
create table document_subtypes (
  key                 text primary key,
  doc_class           text not null check (doc_class in ('identity','address','education','employment','bank','tax','photo','other','unknown')),
  government_issued   boolean not null,
  default_sensitivity text not null check (default_sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  description         text not null
);

insert into document_subtypes (key, doc_class, government_issued, default_sensitivity, description) values
 ('aadhaar','identity',true,'highly_sensitive','Aadhaar card, e-Aadhaar or letter. Collect a MASKED copy (first 8 digits hidden); never store or show the full number.'),
 ('pan','identity',true,'highly_sensitive','PAN card or allotment letter. Number stored as ciphertext; last four digits displayed.'),
 ('passport','identity',true,'highly_sensitive','Passport data page. Machine-readable zone check digits can be verified offline (format only).'),
 ('driving_licence','identity',true,'highly_sensitive','Driving licence issued by a state transport authority.'),
 ('voter_id','identity',true,'highly_sensitive','Election photo identity card (EPIC).'),
 ('uan_epf','employment',true,'sensitive','Universal Account Number card, EPFO passbook or declaration form.'),
 ('esic','employment',true,'sensitive','ESIC insurance number or card.'),
 ('itr_ack','tax',true,'sensitive','Income-tax return acknowledgement issued by the tax department.'),
 ('caste_community_certificate','identity',true,'highly_sensitive','Caste or community certificate: special-category personal data. Collect only for a specific, documented lawful need.'),
 ('police_verification','other',true,'highly_sensitive','Police verification or clearance certificate. Collect only where the employer has a documented need.'),
 ('form16','tax',false,'sensitive','Form 16 / TDS certificate from a previous employer.'),
 ('education_certificate','education',false,'sensitive','Marksheet, degree or diploma from a board, university or institute.'),
 ('address_proof','address',false,'sensitive','Utility bill, rent agreement or other address proof.'),
 ('bank_cancelled_cheque','bank',false,'highly_sensitive','Cancelled cheque showing account and IFSC.'),
 ('bank_passbook','bank',false,'highly_sensitive','Bank passbook or statement page.'),
 ('payslip','employment',false,'sensitive','Salary slip from a previous employer.'),
 ('experience_letter','employment',false,'sensitive','Experience letter from a previous employer.'),
 ('relieving_letter','employment',false,'sensitive','Relieving letter from a previous employer.'),
 ('offer_letter','employment',false,'sensitive','Offer or appointment letter.'),
 ('photo','photo',false,'sensitive','Passport-size photograph.'),
 ('other','other',false,'sensitive','Other document accepted by the employer.'),
 ('unknown','unknown',false,'sensitive','Not yet classified.');

alter table case_documents add column doc_subtype text references document_subtypes(key);
alter table ai_results     add column document_subtype text references document_subtypes(key);
create index case_documents_subtype_idx on case_documents (workspace_id, doc_subtype);

create table document_type_policies (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  doc_subtype       text not null references document_subtypes(key),
  collect_mode      text not null default 'not_collected' check (collect_mode in ('not_collected','optional','required')),
  require_masked    boolean not null default false,
  store_file        boolean not null default true,       -- false = extract, review, then delete the file
  retain_days       integer check (retain_days > 0),     -- NULL until counsel/customer decide (decision D-6)
  reveal_permission text not null default 'document.read_sensitive' references permissions(key),
  purpose           text not null default '',            -- the employer's lawful purpose for collecting this document
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, doc_subtype),
  unique (id, workspace_id),
  check (doc_subtype <> 'aadhaar' or require_masked),                                   -- Aadhaar: masked copy only
  check (collect_mode = 'not_collected' or length(btrim(purpose)) >= 10)                -- purpose limitation
);
call app.with_updated_at('document_type_policies');
call app.tenantize('document_type_policies');

-- Default policy templates for a new workspace. They are starting points: the employer decides.
create or replace function app.seed_document_policies(p_ws uuid) returns integer language plpgsql as $$
declare n integer;
begin
  if p_ws is distinct from app.current_workspace() then raise exception 'context workspace mismatch'; end if;
  insert into document_type_policies (workspace_id, doc_subtype, collect_mode, require_masked, purpose, notes) values
   (p_ws,'aadhaar','optional',true,'Statutory identity or provident-fund onboarding where the employer needs it (masked copy only)','Ask for the masked Aadhaar. Never store or show the full number.'),
   (p_ws,'pan','required',false,'PAN is needed for tax deduction at source and payroll','Number stored as ciphertext; last four displayed.'),
   (p_ws,'passport','optional',false,'Identity or address proof where the employer accepts a passport','Optional alternative to other identity documents.'),
   (p_ws,'driving_licence','optional',false,'Identity or address proof where the employer accepts a driving licence','Optional alternative to other identity documents.'),
   (p_ws,'voter_id','optional',false,'Identity or address proof where the employer accepts a voter ID','Optional alternative to other identity documents.'),
   (p_ws,'uan_epf','optional',false,'Provident-fund account transfer or nomination for the new employee','Only if the employee has an existing UAN.'),
   (p_ws,'esic','optional',false,'Insurance continuity for eligible employees','Only if applicable.'),
   (p_ws,'itr_ack','not_collected',false,'','Not collected by default. Enable only with a documented need.'),
   (p_ws,'caste_community_certificate','not_collected',false,'','Special-category data. Not collected by default; enable only for a specific lawful need.'),
   (p_ws,'police_verification','not_collected',false,'','Not collected by default; enable only where the employer has a documented need.')
  on conflict (workspace_id, doc_subtype) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Enforcement on every document row.
create or replace function app.guard_document_subtype() returns trigger language plpgsql as $$
declare v_cat document_subtypes%rowtype; v_pol document_type_policies%rowtype;
begin
  if new.doc_subtype is null then return new; end if;
  select * into v_cat from document_subtypes where key = new.doc_subtype;
  if new.doc_class <> 'unknown' and new.doc_class <> v_cat.doc_class then
    raise exception 'document class % does not match subtype % (expected %)', new.doc_class, new.doc_subtype, v_cat.doc_class using errcode = '23514';
  end if;
  if v_cat.default_sensitivity = 'highly_sensitive' and new.sensitivity <> 'highly_sensitive' then
    raise exception '% documents must be classified highly_sensitive', new.doc_subtype using errcode = '23514';
  end if;
  select * into v_pol from document_type_policies where workspace_id = new.workspace_id and doc_subtype = new.doc_subtype;
  if v_cat.government_issued then
    if v_pol.id is null then
      raise exception 'no collection policy exists for government document type % (fail closed)', new.doc_subtype using errcode = '23514';
    end if;
    if v_pol.collect_mode = 'not_collected' then
      raise exception 'this workspace does not collect % documents', new.doc_subtype using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' and new.retain_until is null and v_pol.retain_days is not null then
    new.retain_until := now() + make_interval(days => v_pol.retain_days);
  end if;
  return new;
end $$;
create trigger trg_case_documents_subtype before insert or update of doc_subtype, sensitivity, doc_class on case_documents
  for each row execute function app.guard_document_subtype();

grant select, insert, update on document_type_policies to formiva_app, formiva_worker;
grant select on document_type_policies to formiva_readonly;
grant select on document_subtypes to formiva_app, formiva_worker, formiva_readonly;
grant select, insert, update on document_subtypes to formiva_ops;
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
