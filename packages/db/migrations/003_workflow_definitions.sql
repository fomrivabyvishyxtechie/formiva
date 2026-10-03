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
