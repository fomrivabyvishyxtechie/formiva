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
