alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists identity_synced_at timestamptz not null default now();
alter table users add column if not exists identity_source_updated_at timestamptz;
create index if not exists users_verified_email_idx on users (email) where email_verified and status = 'active';

update workspace_invitations set email = lower(btrim(email::text));
alter table workspace_invitations add column if not exists revoked_at timestamptz;
alter table workspace_invitations add column if not exists consumed_at timestamptz;
alter table workspace_invitations add column if not exists consumed_by uuid references users(id);
alter table workspace_invitations add column if not exists updated_at timestamptz not null default now();
alter table workspace_invitations add column if not exists idempotency_key_hash bytea check (idempotency_key_hash is null or octet_length(idempotency_key_hash) = 32);
alter table workspace_invitations add column if not exists request_hash bytea check (request_hash is null or octet_length(request_hash) = 32);
alter table workspace_invitations drop constraint if exists workspace_invitations_lifecycle_check;
alter table workspace_invitations drop constraint if exists workspace_invitations_not_revoked_and_consumed;
alter table workspace_invitations drop constraint if exists workspace_invitations_idempotency_pair_check;
alter table workspace_invitations drop constraint if exists workspace_invitations_normalized_email_check;
alter table workspace_invitations drop constraint if exists workspace_invitations_expiry_check;
alter table workspace_invitations add constraint workspace_invitations_lifecycle_check check ((consumed_at is null) = (consumed_by is null));
alter table workspace_invitations add constraint workspace_invitations_not_revoked_and_consumed check (revoked_at is null or consumed_at is null);
alter table workspace_invitations add constraint workspace_invitations_idempotency_pair_check check ((idempotency_key_hash is null) = (request_hash is null));
alter table workspace_invitations add constraint workspace_invitations_normalized_email_check check (email::text = lower(btrim(email::text)));
alter table workspace_invitations add constraint workspace_invitations_expiry_check check (expires_at > created_at);
create unique index if not exists workspace_invitations_idempotency_idx on workspace_invitations (workspace_id, created_by, idempotency_key_hash) where idempotency_key_hash is not null;
create index if not exists workspace_invitations_active_idx on workspace_invitations (workspace_id) where revoked_at is null and consumed_at is null;
call app.tenantize('workspace_invitations');
grant select, insert, update on workspace_invitations to formiva_app;

alter table workspace_bootstrap_idempotency add column if not exists workspace_name text;
alter table workspace_bootstrap_idempotency add column if not exists workspace_slug citext;
update workspace_bootstrap_idempotency b
   set workspace_name = w.name, workspace_slug = w.slug
  from workspaces w
 where b.workspace_id = w.id
   and (b.workspace_name is null or b.workspace_slug is null);
alter table workspace_bootstrap_idempotency alter column workspace_name set not null;
alter table workspace_bootstrap_idempotency alter column workspace_slug set not null;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'formiva_bootstrap_definer') then create role formiva_bootstrap_definer nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'formiva_acceptance_definer') then create role formiva_acceptance_definer nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'formiva_identity_definer') then create role formiva_identity_definer nologin noinherit bypassrls; end if;
end $$;
grant usage on schema public, app to formiva_bootstrap_definer, formiva_acceptance_definer, formiva_identity_definer;

revoke all on workspace_bootstrap_idempotency from formiva_bootstrap_definer;
grant select, insert on workspace_bootstrap_idempotency to formiva_bootstrap_definer;
grant select on users, permissions to formiva_bootstrap_definer;
grant insert on workspaces, roles, role_permissions, workspace_members, document_type_policies, audit_events to formiva_bootstrap_definer;

revoke all on users, workspace_invitations, workspace_members, roles, audit_events from formiva_acceptance_definer;
grant select on users, roles to formiva_acceptance_definer;
grant select, update on workspace_invitations to formiva_acceptance_definer;
grant select, insert, update on workspace_members to formiva_acceptance_definer;
grant insert on audit_events to formiva_acceptance_definer;

revoke all on users from formiva_identity_definer;
grant select, insert, update on users to formiva_identity_definer;

create or replace function app.bootstrap_workspace(p_subject text, p_name text, p_slug citext, p_key_hash bytea, p_request_hash bytea)
returns table (workspace_id uuid, name text, slug citext, replay boolean)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_user uuid; v_workspace uuid; v_existing workspace_bootstrap_idempotency%rowtype; v_name text; v_slug citext; v_owner_role uuid; v_role uuid; d record;
begin
  if p_subject is null or btrim(p_subject) = '' or octet_length(p_key_hash) <> 32 or octet_length(p_request_hash) <> 32 or p_name is null or btrim(p_name) = '' or p_slug is null or lower(btrim(p_slug::text)) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'invalid bootstrap request' using errcode = '22023'; end if;
  v_name := btrim(p_name);
  v_slug := lower(btrim(p_slug::text));
  perform pg_advisory_xact_lock(hashtextextended(p_subject || encode(p_key_hash, 'hex'), 19));
  perform pg_advisory_xact_lock(hashtextextended(p_subject, 31));
  select * into v_existing from workspace_bootstrap_idempotency where auth_subject = p_subject and key_hash = p_key_hash;
  if found then
    if v_existing.request_hash <> p_request_hash then raise exception 'idempotency conflict' using errcode = 'P0001'; end if;
    return query select v_existing.workspace_id, v_existing.workspace_name, v_existing.workspace_slug, true; return;
  end if;
  select id into v_user from users where auth_subject = p_subject and status = 'active' and email_verified and email_verified_at is not null and identity_synced_at >= now() - interval '15 minutes' and identity_source_updated_at is not null;
  if v_user is null then raise exception 'trusted identity unavailable' using errcode = '28000'; end if;
  v_workspace := gen_random_uuid();
  insert into workspaces (id, name, slug, status) values (v_workspace, v_name, v_slug, 'active');
  perform app.set_context(v_workspace, v_user);
  for d in select * from (values
    ('owner'::text, null::text[]),
    ('admin', array['workspace.manage','member.manage','form.edit','form.publish','workflow.edit','workflow.publish','case.read','case.create','case.reassign','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','audit.read','retention.manage','deletion.request','apikey.manage','analytics.read']),
    ('reviewer', array['case.read','case.review','case.correct','document.read_sensitive','analytics.read']),
    ('approver', array['case.read','case.approve']),
    ('integration_operator', array['case.read','integration.manage','integration.replay','deadletter.replay','safe_mode.manage','analytics.read']),
    ('auditor', array['case.read','audit.read','audit.export','analytics.read']),
    ('viewer', array['case.read','analytics.read'])
  ) as t(name, perms) loop
    v_role := gen_random_uuid();
    insert into roles (id, workspace_id, name, is_system) values (v_role, v_workspace, d.name, true);
    insert into role_permissions (workspace_id, role_id, permission_key)
      select v_workspace, v_role, k from unnest(coalesce(d.perms, (select array_agg(key) from permissions))) k;
    if d.name = 'owner' then v_owner_role := v_role; end if;
  end loop;
  insert into workspace_members (workspace_id, user_id, role_id, status, joined_at)
  values (v_workspace, v_user, v_owner_role, 'active', now());
  insert into document_type_policies
    (workspace_id, doc_subtype, collect_mode, require_masked, purpose, notes)
  values
    (v_workspace, 'aadhaar', 'optional', true, 'Statutory identity or provident-fund onboarding where the employer needs it (masked copy only)', 'Ask for the masked Aadhaar. Never store or show the full number.'),
    (v_workspace, 'pan', 'required', false, 'PAN is needed for tax deduction at source and payroll', 'Number stored as ciphertext; last four displayed.'),
    (v_workspace, 'passport', 'optional', false, 'Identity or address proof where the employer accepts a passport', 'Optional alternative to other identity documents.'),
    (v_workspace, 'driving_licence', 'optional', false, 'Identity or address proof where the employer accepts a driving licence', 'Optional alternative to other identity documents.'),
    (v_workspace, 'voter_id', 'optional', false, 'Identity or address proof where the employer accepts a voter ID', 'Optional alternative to other identity documents.'),
    (v_workspace, 'uan_epf', 'optional', false, 'Provident-fund account transfer or nomination for the new employee', 'Only if the employee has an existing UAN.'),
    (v_workspace, 'esic', 'optional', false, 'Insurance continuity for eligible employees', 'Only if applicable.'),
    (v_workspace, 'itr_ack', 'not_collected', false, '', 'Not collected by default. Enable only with a documented need.'),
    (v_workspace, 'caste_community_certificate', 'not_collected', false, '', 'Special-category data. Not collected by default; enable only for a specific lawful need.'),
    (v_workspace, 'police_verification', 'not_collected', false, '', 'Not collected by default; enable only where the employer has a documented need.');
  insert into workspace_bootstrap_idempotency(auth_subject, key_hash, request_hash, workspace_id, workspace_name, workspace_slug)
  values (p_subject, p_key_hash, p_request_hash, v_workspace, v_name, v_slug);
  insert into audit_events
    (workspace_id, actor_type, actor_id, action, object_type, object_id, payload, event_hash)
  values
    (v_workspace, 'user', v_user::text, 'workspace.bootstrapped', 'workspace', v_workspace::text, '{}'::jsonb, '\x00');
  return query select v_workspace, v_name, v_slug, false;
end $$;

create or replace function app.sync_user_identity(p_subject text, p_email text, p_display_name text, p_email_verified boolean, p_source_updated_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_user users%rowtype; v_email citext; v_verified boolean;
begin
  if p_subject is null or btrim(p_subject) = '' then raise exception 'invalid identity subject' using errcode = '22023'; end if;
  v_email := nullif(lower(btrim(p_email)), '')::citext;
  v_verified := coalesce(p_email_verified, false) and v_email is not null and p_source_updated_at is not null;
  perform pg_advisory_xact_lock(hashtextextended(p_subject, 31));
  select * into v_user from users where auth_subject = p_subject for update;
  if not found then
    insert into users (auth_subject, email, display_name, email_verified, email_verified_at, identity_synced_at, identity_source_updated_at)
    values (p_subject, coalesce(v_email, (p_subject || '@invalid.local')::citext), p_display_name, v_verified,
      case when v_verified then now() else null end, now(), p_source_updated_at);
    return;
  end if;
  if p_source_updated_at is null or
     (v_user.identity_source_updated_at is not null and p_source_updated_at < v_user.identity_source_updated_at) then
    update users set email_verified = false, email_verified_at = null, identity_synced_at = now(), updated_at = now()
    where id = v_user.id;
    return;
  end if;
  update users set email = coalesce(v_email, v_user.email), display_name = p_display_name,
    email_verified = v_verified, email_verified_at = case when v_verified then now() else null end,
    identity_synced_at = now(), identity_source_updated_at = p_source_updated_at, updated_at = now()
  where id = v_user.id;
end $$;

create or replace function app.accept_invitation(p_subject text, p_token_hash bytea)
returns table (workspace_id uuid, user_id uuid, role text)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_inv workspace_invitations%rowtype; v_user uuid; v_email citext; v_role text;
begin
  if p_subject is null or btrim(p_subject) = '' or octet_length(p_token_hash) <> 32 then raise exception 'invalid invitation' using errcode = '22023'; end if;
  select i.* into v_inv from workspace_invitations i where i.token_hash = p_token_hash for update;
  if not found or v_inv.expires_at <= now() or v_inv.revoked_at is not null or v_inv.consumed_at is not null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_subject, 31));
  select u.id, u.email into v_user, v_email from users u where u.auth_subject = p_subject and u.status = 'active'
    and u.email_verified and u.email_verified_at is not null
    and u.identity_synced_at >= now() - interval '15 minutes' and u.identity_source_updated_at is not null;
  if v_user is null then raise exception 'trusted identity unavailable' using errcode = '28000'; end if;
  if v_inv.email <> v_email then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  select r.name into v_role from roles r where r.id = v_inv.role_id and r.workspace_id = v_inv.workspace_id;
  if v_role is null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  insert into workspace_members(workspace_id, user_id, role_id, status, joined_at)
  values (v_inv.workspace_id, v_user, v_inv.role_id, 'active', now())
  on conflict on constraint workspace_members_pkey do update
    set status = 'active', role_id = excluded.role_id,
        joined_at = coalesce(workspace_members.joined_at, now());
  update workspace_invitations set consumed_at = now(), consumed_by = v_user where id = v_inv.id;
  perform app.set_context(v_inv.workspace_id, v_user);
  insert into audit_events
    (workspace_id, actor_type, actor_id, action, object_type, object_id, payload, event_hash)
  values
    (v_inv.workspace_id, 'user', v_user::text, 'workspace.invitation_accepted',
      'workspace_invitation', v_inv.id::text, '{}'::jsonb, '\x00');
  return query select v_inv.workspace_id, v_user, v_role;
end $$;

alter function app.bootstrap_workspace(text, text, citext, bytea, bytea) owner to formiva_bootstrap_definer;
alter function app.accept_invitation(text, bytea) owner to formiva_acceptance_definer;
alter function app.sync_user_identity(text, text, text, boolean, timestamptz) owner to formiva_identity_definer;
revoke all on function app.bootstrap_workspace(text, text, citext, bytea, bytea) from public;
revoke all on function app.accept_invitation(text, bytea) from public;
revoke all on function app.sync_user_identity(text, text, text, boolean, timestamptz) from public;
grant execute on function app.bootstrap_workspace(text, text, citext, bytea, bytea) to formiva_app;
grant execute on function app.accept_invitation(text, bytea) to formiva_app;
grant execute on function app.sync_user_identity(text, text, text, boolean, timestamptz) to formiva_app;

alter function app.audit_chain() security definer;
alter function app.audit_chain() set search_path = pg_catalog, public, app;
