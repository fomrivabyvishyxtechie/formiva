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
