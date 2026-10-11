-- Trusted identity projection and the only two pre-membership capabilities.
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists identity_synced_at timestamptz not null default now();
alter table users add column if not exists identity_source_updated_at timestamptz;
create index if not exists users_verified_email_idx on users (email) where email_verified and status = 'active';

alter table workspace_invitations add column if not exists revoked_at timestamptz;
alter table workspace_invitations add column if not exists consumed_at timestamptz;
alter table workspace_invitations add column if not exists consumed_by uuid references users(id);
alter table workspace_invitations add column if not exists idempotency_key_hash bytea check (idempotency_key_hash is null or octet_length(idempotency_key_hash) = 32);
alter table workspace_invitations add column if not exists request_hash bytea check (request_hash is null or octet_length(request_hash) = 32);
alter table workspace_invitations add constraint workspace_invitations_lifecycle_check check (consumed_at is null or consumed_by is not null);
alter table workspace_invitations add constraint workspace_invitations_not_revoked_and_consumed check (revoked_at is null or consumed_at is null);
create unique index if not exists workspace_invitations_idempotency_idx on workspace_invitations (workspace_id, created_by, idempotency_key_hash) where idempotency_key_hash is not null;
create index if not exists workspace_invitations_active_idx on workspace_invitations (workspace_id) where revoked_at is null and consumed_at is null;
grant select, insert, update on workspace_invitations to formiva_app;

create table workspace_bootstrap_idempotency (
  auth_subject text not null,
  key_hash bytea not null check (octet_length(key_hash) = 32),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  workspace_id uuid not null references workspaces(id),
  created_at timestamptz not null default now(),
  primary key (auth_subject, key_hash)
);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'formiva_bootstrap_definer') then create role formiva_bootstrap_definer nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'formiva_acceptance_definer') then create role formiva_acceptance_definer nologin noinherit bypassrls; end if;
end $$;
grant usage on schema public, app to formiva_bootstrap_definer, formiva_acceptance_definer;
grant select on users, permissions to formiva_bootstrap_definer;
grant insert on workspaces, roles, role_permissions, workspace_members, document_type_policies, workspace_bootstrap_idempotency, audit_events to formiva_bootstrap_definer;
grant select, insert, update on users, workspace_invitations, workspace_members, audit_events to formiva_acceptance_definer;
grant select on roles to formiva_acceptance_definer;

create or replace function app.bootstrap_workspace(p_subject text, p_name text, p_slug citext, p_key_hash bytea, p_request_hash bytea)
returns table (workspace_id uuid, name text, slug citext, replay boolean)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_user uuid; v_workspace uuid; v_existing workspace_bootstrap_idempotency%rowtype; v_role uuid; d record;
begin
  if p_subject is null or btrim(p_subject) = '' or octet_length(p_key_hash) <> 32 or octet_length(p_request_hash) <> 32 or p_name is null or btrim(p_name) = '' or p_slug is null or btrim(p_slug::text) = '' then raise exception 'invalid bootstrap request' using errcode = '22023'; end if;
  select * into v_existing from workspace_bootstrap_idempotency where auth_subject = p_subject and key_hash = p_key_hash for update;
  if found then
    if v_existing.request_hash <> p_request_hash then raise exception 'idempotency conflict' using errcode = '23505'; end if;
    return query select w.id, w.name, w.slug, true from workspaces w where w.id = v_existing.workspace_id; return;
  end if;
  select id into v_user from users where auth_subject = p_subject and status = 'active' and email_verified for update;
  if v_user is null then raise exception 'trusted identity unavailable' using errcode = '28000'; end if;
  insert into workspaces (name, slug, status) values (btrim(p_name), lower(btrim(p_slug::text)), 'active') returning id into v_workspace;
  for d in select * from (values
    ('owner'::text, array['workspace.manage','member.manage','form.edit','form.publish','workflow.edit','workflow.publish','case.read','case.create','case.reassign','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','audit.read','retention.manage','deletion.request','apikey.manage','analytics.read']::text[]),
    ('admin', array['workspace.manage','member.manage','form.edit','form.publish','workflow.edit','workflow.publish','case.read','case.create','case.reassign','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','audit.read','retention.manage','deletion.request','apikey.manage','analytics.read']::text[]),
    ('reviewer', array['case.read','case.review','case.correct','document.read_sensitive','analytics.read']::text[]), ('approver', array['case.read','case.approve']::text[]), ('integration_operator', array['case.read','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','analytics.read']::text[]), ('viewer', array['case.read','analytics.read']::text[])
  ) as x(name, permissions) loop
    insert into roles (workspace_id, name, is_system) values (v_workspace, d.name, true) returning id into v_role;
    insert into role_permissions (workspace_id, role_id, permission_key) select v_workspace, v_role, p from unnest(d.permissions) p;
  end loop;
  insert into workspace_members (workspace_id, user_id, role_id, status, joined_at) select v_workspace, v_user, id, 'active', now() from roles where workspace_id = v_workspace and name = 'owner';
  insert into workspace_bootstrap_idempotency(auth_subject, key_hash, request_hash, workspace_id) values (p_subject, p_key_hash, p_request_hash, v_workspace);
  perform app.set_context(v_workspace, v_user);
  perform app.audit('workspace.bootstrapped', 'workspace', v_workspace::text, null, '{}'::jsonb, 'user', v_user::text);
  return query select w.id, w.name, w.slug, false from workspaces w where w.id = v_workspace;
end $$;

create or replace function app.accept_invitation(p_subject text, p_token_hash bytea)
returns table (workspace_id uuid, user_id uuid, role text)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_inv workspace_invitations%rowtype; v_user uuid; v_email citext; v_role text;
begin
  if p_subject is null or btrim(p_subject) = '' or octet_length(p_token_hash) <> 32 then raise exception 'invalid invitation' using errcode = '22023'; end if;
  select id, email into v_user, v_email from users where auth_subject = p_subject and status = 'active' and email_verified and identity_synced_at >= now() - interval '15 minutes' for update;
  if v_user is null then raise exception 'trusted identity unavailable' using errcode = '28000'; end if;
  select * into v_inv from workspace_invitations where token_hash = p_token_hash for update;
  if not found or v_inv.expires_at <= now() or v_inv.revoked_at is not null or v_inv.consumed_at is not null or v_inv.email <> v_email then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  select name into v_role from roles where id = v_inv.role_id and workspace_id = v_inv.workspace_id;
  if v_role is null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  insert into workspace_members(workspace_id, user_id, role_id, status, joined_at) values (v_inv.workspace_id, v_user, v_inv.role_id, 'active', now()) on conflict (workspace_id, user_id) do update set status = 'active', role_id = excluded.role_id, joined_at = coalesce(workspace_members.joined_at, now());
  update workspace_invitations set consumed_at = now(), consumed_by = v_user where id = v_inv.id;
  perform app.set_context(v_inv.workspace_id, v_user);
  perform app.audit('workspace.invitation_accepted', 'workspace_invitation', v_inv.id::text, null, '{}'::jsonb, 'user', v_user::text);
  return query select v_inv.workspace_id, v_user, v_role;
end $$;

alter function app.bootstrap_workspace(text, text, citext, bytea, bytea) owner to formiva_bootstrap_definer;
alter function app.accept_invitation(text, bytea) owner to formiva_acceptance_definer;
revoke all on function app.bootstrap_workspace(text, text, citext, bytea, bytea) from public;
revoke all on function app.accept_invitation(text, bytea) from public;
grant execute on function app.bootstrap_workspace(text, text, citext, bytea, bytea) to formiva_app;
grant execute on function app.accept_invitation(text, bytea) to formiva_app;
