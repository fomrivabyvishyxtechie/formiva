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
