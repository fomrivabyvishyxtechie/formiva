create or replace function app.bootstrap_workspace(p_subject text, p_name text, p_slug citext, p_key_hash bytea, p_request_hash bytea)
returns table (workspace_id uuid, name text, slug citext, replay boolean)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_user uuid; v_existing workspace_bootstrap_idempotency%rowtype; v_name text; v_slug citext; v_workspace uuid; v_owner_role uuid; v_role uuid; d record;
begin
  if p_subject is null or btrim(p_subject) = '' or octet_length(p_key_hash) <> 32 or octet_length(p_request_hash) <> 32 or p_name is null or btrim(p_name) = '' or p_slug is null or lower(btrim(p_slug::text)) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'invalid bootstrap request' using errcode = '22023'; end if;
  v_name := btrim(p_name);
  v_slug := lower(btrim(p_slug::text));
  perform pg_advisory_xact_lock(hashtextextended(p_subject || encode(p_key_hash, 'hex'), 19));
  perform pg_advisory_xact_lock(hashtextextended(p_subject, 31));
  select id into v_user from users where auth_subject = p_subject and status = 'active'
    and email_verified and email_verified_at is not null
    and identity_synced_at >= now() - interval '15 minutes' and identity_source_updated_at is not null;
  if v_user is null then raise exception 'trusted identity unavailable' using errcode = '28000'; end if;
  select * into v_existing from workspace_bootstrap_idempotency where auth_subject = p_subject and key_hash = p_key_hash;
  if found then
    if v_existing.request_hash <> p_request_hash then raise exception 'idempotency conflict' using errcode = 'P0001'; end if;
    return query select v_existing.workspace_id, v_existing.workspace_name, v_existing.workspace_slug, true; return;
  end if;
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

create or replace function app.accept_invitation(p_subject text, p_token_hash bytea)
returns table (workspace_id uuid, user_id uuid, role text)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_inv workspace_invitations%rowtype; v_user uuid; v_email citext; v_role text; v_rows integer;
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
  perform 1 from workspace_members
    where workspace_id = v_inv.workspace_id and user_id = v_user and status = 'active'
    for update;
  if found then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  select r.name into v_role from roles r where r.id = v_inv.role_id and r.workspace_id = v_inv.workspace_id;
  if v_role is null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  insert into workspace_members(workspace_id, user_id, role_id, status, joined_at)
  values (v_inv.workspace_id, v_user, v_inv.role_id, 'active', now())
  on conflict on constraint workspace_members_pkey do update
    set status = 'active', role_id = excluded.role_id,
        joined_at = coalesce(workspace_members.joined_at, now())
    where workspace_members.status <> 'active';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  update workspace_invitations set consumed_at = now(), consumed_by = v_user where id = v_inv.id;
  perform app.set_context(v_inv.workspace_id, v_user);
  insert into audit_events
    (workspace_id, actor_type, actor_id, action, object_type, object_id, payload, event_hash)
  values
    (v_inv.workspace_id, 'user', v_user::text, 'workspace.invitation_accepted',
      'workspace_invitation', v_inv.id::text, '{}'::jsonb, '\x00');
  return query select v_inv.workspace_id, v_user, v_role;
end $$;
