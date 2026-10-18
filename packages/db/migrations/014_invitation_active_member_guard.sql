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
  perform 1 from workspace_members m
    where m.workspace_id = v_inv.workspace_id and m.user_id = v_user and m.status = 'active'
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
