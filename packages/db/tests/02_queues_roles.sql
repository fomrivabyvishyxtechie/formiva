-- Run after 01_fixtures_and_tests.sql (uses its fixtures). Queue claiming, reaper, grants, login helpers.
\set ON_ERROR_STOP on
set client_min_messages = notice;

-- ---------------- T13 job claiming ----------------
do $$
declare n int; r record; ids uuid[] := '{}';
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  for n in 1..3 loop
    insert into ai_jobs (workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version, status)
      values (tf.id('wsA'), tf.id('caseA1'), tf.id('docA1'), 'claim-'||n, digest('doc','sha256'), 'p', 'queued');
  end loop;
  set local role formiva_worker;
  perform app.set_context(null, null);
  for n in 1..6 loop
    select * into r from ops.claim_next_ai_job('worker-'||n, 60);
    exit when r.job_id is null;
    ids := ids || r.job_id;
  end loop;
  perform tf.expect('T13a worker claimed exactly the 4 queued jobs (across tenants, no context)', cardinality(ids), 4);
  perform tf.expect('T13b every claim was a distinct job', (select count(distinct x) from unnest(ids) x)::int, 4);
  reset role;
  perform tf.expect('T13c claimed rows carry lease + attempt count', (select count(*) from ai_jobs where status = 'claimed' and lease_until > now() and attempt_count = 1)::int, 4);
  set local role formiva_app;
  perform tf.must_fail('T13d API role cannot call the claim function', 'select * from ops.claim_next_ai_job(''x'', 60)', '42501');
end $$;

-- ---------------- T14 reaper: leases, dead letters, unknown outcomes ----------------
do $$
declare r record; v_i uuid; v_dl int;
begin
  -- expire all AI leases; push ONE job to its retry limit
  update ai_jobs set lease_until = now() - interval '1 minute' where status = 'claimed';
  update ai_jobs set attempt_count = max_attempts where idempotency_key = 'claim-1';
  set local role formiva_worker;
  select * into r from ops.requeue_expired_leases() where queue = 'ai_jobs';
  reset role;
  perform tf.expect('T14a expired jobs below retry limit -> retrying', r.requeued, 3);
  perform tf.expect('T14b job at retry limit -> dead_letter', r.dead_lettered, 1);
  perform tf.expect('T14c dead-letter item is visible (never silently dropped)', (select count(*) from dead_letter_items where source_type = 'ai_job' and status = 'open')::int, 1);
  perform tf.expect('T14d lease columns cleared automatically', (select count(*) from ai_jobs where status in ('retrying','dead_letter') and lease_owner is not null)::int, 0);

  -- integration interaction: expired lease while IN FLIGHT must become UNKNOWN, never re-queued
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  select id into v_i from integration_interactions where idempotency_key = 'case-A2:notify:v1';
  update integration_interactions set status = 'queued' where id = v_i;
  set local role formiva_worker; perform app.set_context(null, null);
  perform 1 from ops.claim_next_interaction('int-worker', 60);
  reset role; perform app.set_context(tf.id('wsA'), tf.id('u1'));
  update integration_interactions set status = 'in_flight', lease_until = now() - interval '1 minute' where id = v_i;
  set local role formiva_worker;
  select * into r from ops.requeue_expired_leases() where queue = 'integrations';
  reset role;
  perform tf.expect('T14e in-flight lease expiry -> UNKNOWN outcome (no blind replay)', r.unknown_outcomes, 1);
  perform tf.expect('T14f interaction status is unknown', (select status from integration_interactions where id = v_i), 'unknown');
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T14g unknown -> queued is forbidden', format('update integration_interactions set status = %L where id = %L', 'queued', v_i), '23514');
  perform tf.must_pass('T14h unknown -> review (human decision)', format('update integration_interactions set status = %L where id = %L', 'review', v_i));
  perform tf.must_pass('T14i review -> queued (authorized replay, same idempotency key)', format('update integration_interactions set status = %L where id = %L', 'queued', v_i));
end $$;

-- ---------------- T15 privileges ----------------
do $$
begin
  set local role formiva_readonly; perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T15a readonly role sees tenant rows through RLS', (select count(*) from cases)::int, 2);
  perform tf.must_fail('T15b readonly role cannot write', format('insert into workspace_counters (workspace_id, name) values (%L, %L)', tf.id('wsA'), 'x'), '42501');
  reset role; set local role formiva_app;
  perform tf.must_fail('T15c API role cannot write the model registry', 'insert into ai_model_registry (model_key, version, digest, runtime, license) values (''m'',''1'',''d'',''r'',''apache-2.0'')', '42501');
  reset role; set local role formiva_worker;
  perform tf.must_fail('T15d worker role cannot delete rows', 'delete from notifications', '42501');
  reset role; set local role formiva_ops;
  perform tf.must_pass('T15e ops role can register a candidate model', 'insert into ai_model_registry (model_key, version, digest, runtime, license) values (''qwen2.5-3b-instruct-q4_k_m'',''1'',''sha256:abc'',''llama.cpp'',''apache-2.0'')');
  perform tf.must_fail('T15f a model cannot be "approved" without an approver', 'update ai_model_registry set approval_status = ''approved''', '23514');
end $$;

-- ---------------- T16-T18 login helpers, tokens, bootstrap, queue health ----------------
do $$
declare v_tok bytea := digest('public-token-1','sha256'); r record;
begin
  set local role formiva_app;
  select count(*) as n, min(role_name) as role, bool_or('case.review' = any(permissions)) as can_review into r from ops.workspaces_for_user('clerk_u3');
  perform tf.expect('T16a user resolves to exactly one workspace', r.n::int, 1);
  perform tf.expect('T16b ... with the reviewer role and case.review permission', r.role || ':' || r.can_review, 'reviewer:true');
  perform tf.expect('T16c unknown Clerk subject resolves to nothing', (select count(*) from ops.workspaces_for_user('nobody'))::int, 0);

  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  insert into respondent_tokens (workspace_id, form_version_id, purpose, token_hash, expires_at)
    values (tf.id('wsA'), tf.id('fvA'), 'public_form', v_tok, now() + interval '7 days');
  insert into respondent_tokens (workspace_id, form_version_id, purpose, token_hash, expires_at)
    values (tf.id('wsA'), tf.id('fvA'), 'public_form', digest('expired','sha256'), now() - interval '1 day');
  perform app.set_context(null, null);
  select * into r from ops.resolve_respondent_token(v_tok);
  perform tf.expect('T17a valid public token resolves to its workspace', r.ws_id, tf.id('wsA'));
  perform tf.expect('T17b expired token resolves to nothing', (select count(*) from ops.resolve_respondent_token(digest('expired','sha256')))::int, 0);
  perform tf.expect('T17c unknown token resolves to nothing', (select count(*) from ops.resolve_respondent_token(digest('guess','sha256')))::int, 0);
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T17d token must be a 32-byte hash (never a raw token)', format('insert into respondent_tokens (workspace_id, form_version_id, purpose, token_hash, expires_at) values (%L,%L,%L,%L,now())', tf.id('wsA'), tf.id('fvA'), 'resume', '\x1234'), '23514');
  reset role;
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T18a bootstrap created 7 system roles', (select count(*) from roles where workspace_id = tf.id('wsA'))::int, 7);
  perform tf.expect('T18b owner holds every permission', (select count(*) from role_permissions rp join roles ro on ro.id = rp.role_id where ro.name = 'owner' and ro.workspace_id = tf.id('wsA'))::int, (select count(*) from permissions)::int);
  perform tf.expect('T18c approver cannot review or export audit', (select count(*) from role_permissions rp join roles ro on ro.id = rp.role_id where ro.name = 'approver' and rp.permission_key in ('case.review','audit.export'))::int, 0);
  set local role formiva_ops;
  perform tf.expect('T19a queue_health exposes 4 queues without tenant data', (select count(*) from ops.queue_health)::int, 4);
  perform tf.expect('T19b dead letter visible in ops metrics', (select dead_letters from ops.queue_health where queue = 'ai_jobs')::int, 1);
end $$;
\echo ALL TESTS PASSED
