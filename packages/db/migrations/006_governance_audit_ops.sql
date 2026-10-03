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
