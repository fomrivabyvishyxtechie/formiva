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
