-- =====================================================================
-- Formiva schema self-test. Run AFTER 001..006. Prints PASS lines; any FAIL aborts with an exception.
-- Run:  psql -v ON_ERROR_STOP=1 -d formiva_test -f 01_fixtures_and_tests.sql
-- =====================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;
drop schema if exists tf cascade;
create schema tf;
create table tf.ids (k text primary key, v uuid not null);
create function tf.id(p text) returns uuid language sql stable as $$ select v from tf.ids where k = p $$;
grant usage on schema tf to public; grant select on tf.ids to public; grant execute on all functions in schema tf to public;

create function tf.must_fail(p_label text, p_sql text, p_state text default null) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if p_state is not null and v_state <> p_state then
      raise exception 'FAIL %: expected sqlstate % but got % (%)', p_label, p_state, v_state, sqlerrm;
    end if;
    raise notice 'PASS  %  [blocked: %  %]', p_label, v_state, left(sqlerrm, 60);
    return;
  end;
  raise exception 'FAIL %: statement succeeded but must be blocked', p_label;
end $$;
create function tf.must_pass(p_label text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'PASS  %', p_label;
exception when others then
  raise exception 'FAIL %: % (%)', p_label, sqlerrm, sqlstate;
end $$;
create function tf.expect(p_label text, p_actual anyelement, p_expected anyelement) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then raise exception 'FAIL %: expected % got %', p_label, p_expected, p_actual; end if;
  raise notice 'PASS  %  (= %)', p_label, p_actual;
end $$;

-- ---------------- fixtures (as superuser) ----------------
do $$
declare wa uuid := gen_random_uuid(); wb uuid := gen_random_uuid();
        u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
        ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid(); fva uuid := gen_random_uuid(); fvb uuid := gen_random_uuid();
        ca1 uuid := gen_random_uuid(); ca2 uuid := gen_random_uuid(); cb1 uuid := gen_random_uuid();
        da1 uuid := gen_random_uuid();
begin
  insert into tf.ids values ('wsA',wa),('wsB',wb),('u1',u1),('u2',u2),('u3',u3),('fvA',fva),('fvB',fvb),('caseA1',ca1),('caseA2',ca2),('caseB1',cb1),('docA1',da1);
  insert into users (id, auth_subject, email) values (u1,'clerk_u1','owner.a@example.test'),(u2,'clerk_u2','owner.b@example.test'),(u3,'clerk_u3','reviewer.a@example.test');
  insert into workspaces (id, slug, name) values (wa,'acme-a','Acme A'),(wb,'beta-b','Beta B');
  perform app.set_context(wa, u1); perform app.bootstrap_workspace(wa, u1);
  perform app.set_context(wb, u2); perform app.bootstrap_workspace(wb, u2);
  perform app.set_context(wa, u1);
  insert into workspace_members (workspace_id, user_id, role_id, status, joined_at)
    select wa, u3, id, 'active', now() from roles where workspace_id = wa and name = 'reviewer';
  insert into form_templates (id, workspace_id, key, name) values (ta, wa, 'onboarding', 'Onboarding');
  insert into form_template_versions (id, workspace_id, template_id, version_number, status, published_at, schema_sha256)
    values (fva, wa, ta, 1, 'published', now(), digest('v1','sha256'));
  insert into cases (id, workspace_id, case_number, form_version_id, status) values (ca1, wa, app.next_counter(wa,'case'), fva, 'draft');
  insert into cases (id, workspace_id, case_number, form_version_id, status, sensitivity) values (ca2, wa, app.next_counter(wa,'case'), fva, 'workflow_ready', 'sensitive');
  insert into case_documents (id, workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, status)
    values (da1, wa, ca1, 'formiva-docs', 'ws/'||wa||'/cases/'||ca1||'/'||da1, 'application/pdf', 1000, digest('doc','sha256'), 'clean');
  perform app.set_context(wb, u2);
  insert into form_templates (id, workspace_id, key, name) values (tb, wb, 'onboarding', 'Onboarding');
  insert into form_template_versions (id, workspace_id, template_id, version_number, status, published_at, schema_sha256)
    values (fvb, wb, tb, 1, 'published', now(), digest('v1','sha256'));
  insert into cases (id, workspace_id, case_number, form_version_id, status) values (cb1, wb, app.next_counter(wb,'case'), fvb, 'draft');
  raise notice 'fixtures ready: 2 workspaces, 3 users, 3 cases';
end $$;

-- ---------------- T01-T04 tenant isolation ----------------
do $$
begin
  set local role formiva_app;
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T01a workspace A sees only its own cases', (select count(*) from cases)::int, 2);
  perform tf.expect('T01b workspace A cannot see workspace B case', (select count(*) from cases where id = tf.id('caseB1'))::int, 0);
  perform app.set_context(tf.id('wsB'), tf.id('u2'));
  perform tf.expect('T01c workspace B sees only its own cases', (select count(*) from cases)::int, 1);
  perform app.set_context(null, null);
  perform tf.expect('T01d no context = zero rows (deny by default)', (select count(*) from cases)::int, 0);
  perform app.set_context(tf.id('wsB'), tf.id('u2'));
  perform tf.must_fail('T02 insert a case into ANOTHER workspace (RLS WITH CHECK)',
     format('insert into cases (workspace_id, case_number, form_version_id) values (%L, 99, %L)', tf.id('wsA'), tf.id('fvA')), '42501');
  perform tf.must_fail('T03 cross-tenant reference (composite FK): B document pointing at A case',
     format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256) values (%L,%L,%L,%L,%L,1,digest(%L,%L))',
            tf.id('wsB'), tf.id('caseA1'), 'b', 'k-cross', 'application/pdf', 'x', 'sha256'), '23503');
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T04a co-members are visible (owner + reviewer)', (select count(*) from users)::int, 2);
  perform tf.expect('T04b other tenant user hidden', (select count(*) from users where id = tf.id('u2'))::int, 0);
  perform tf.expect('T04c workspaces table shows only own workspace', (select count(*) from workspaces)::int, 1);
end $$;

-- ---------------- T05 append-only ----------------
do $$
declare v_exec uuid; v_job uuid; v_res uuid; v_rd uuid; v_audit uuid;
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  insert into ai_jobs (workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version, status)
    values (tf.id('wsA'), tf.id('caseA1'), tf.id('docA1'), 'job-1', digest('doc','sha256'), 'onboarding-v3', 'created') returning id into v_job;
  insert into ai_executions (workspace_id, ai_job_id, attempt_no) values (tf.id('wsA'), v_job, 1) returning id into v_exec;
  insert into ai_results (workspace_id, ai_execution_id, document_class, detected_language, confidence, confidence_components, sensitivity, routing_recommendation, schema_version)
    values (tf.id('wsA'), v_exec, 'identity', 'en', 0.94, '{"model":0.96,"ocr":0.93,"evidence":0.95,"rule_agreement":1.0}', 'sensitive', 'human_review', 'v1') returning id into v_res;
  insert into routing_decisions (workspace_id, case_id, ai_result_id, decision_key, rule_version, policy_version, action, route)
    values (tf.id('wsA'), tf.id('caseA1'), v_res, 'rd-1', 'r1', 'onboarding-v3', 'notify', 'human_review') returning id into v_rd;
  v_audit := app.audit('test.event','case', tf.id('caseA1')::text);
  insert into tf.ids values ('job1', v_job), ('res1', v_res), ('rd1', v_rd), ('audit1', v_audit);
  perform tf.must_fail('T05a UPDATE ai_results (immutable AI output)', format('update ai_results set confidence = 0.99 where id = %L', v_res), '55000');
  perform tf.must_fail('T05b DELETE routing_decisions', format('delete from routing_decisions where id = %L', v_rd), '55000');
  perform tf.must_fail('T05c UPDATE audit_events', format('update audit_events set reason = %L where id = %L', 'edited', v_audit), '55000');
  perform tf.must_fail('T05d DELETE audit_events', format('delete from audit_events where id = %L', v_audit), '55000');
  perform tf.must_fail('T05e TRUNCATE audit_events', 'truncate audit_events', '55000');
end $$;
do $$
begin
  set local role formiva_app;
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T05f app role has NO update privilege on audit_events', format('update audit_events set reason = %L', 'x'), '42501');
  perform tf.must_fail('T05g app role has NO delete privilege on ai_results', 'delete from ai_results', '42501');
end $$;

-- ---------------- T06 audit hash chain ----------------
do $$
declare r record; i int;
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  for i in 1..5 loop perform app.audit('test.chain.'||i, 'case', tf.id('caseA1')::text, null, jsonb_build_object('n', i)); end loop;
  select * into r from app.verify_audit_chain(tf.id('wsA'));
  perform tf.expect('T06a hash chain verifies (untampered)', r.ok, true);
  raise notice '      chain length checked: %', r.checked;
  begin  -- tamper as superuser with triggers off, detect, then roll the tamper back
    set local session_replication_role = replica;
    update audit_events set payload = '{"n":999}' where workspace_id = tf.id('wsA') and action = 'test.chain.3';
    set local session_replication_role = origin;
    select * into r from app.verify_audit_chain(tf.id('wsA'));
    if r.ok then raise exception 'FAIL T06b tamper was NOT detected'; end if;
    raise notice 'PASS  T06b tampering detected at chain_seq %', r.first_bad_seq;
    raise exception 'rollback_tamper';
  exception when others then
    if sqlerrm <> 'rollback_tamper' then raise; end if;
  end;
  select * into r from app.verify_audit_chain(tf.id('wsA'));
  perform tf.expect('T06c chain verifies again after tamper rollback', r.ok, true);
  perform app.set_context(tf.id('wsB'), tf.id('u2'));
  select * into r from app.verify_audit_chain(tf.id('wsB'));
  perform tf.expect('T06d chains are independent per workspace', r.ok, true);
end $$;

-- ---------------- T07 idempotency ----------------
do $$
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T07a duplicate AI job idempotency key',
    format('insert into ai_jobs (workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version) values (%L,%L,%L,%L,digest(%L,%L),%L)',
      tf.id('wsA'), tf.id('caseA1'), tf.id('docA1'), 'job-1', 'doc', 'sha256', 'p'), '23505');
  insert into integration_interactions (workspace_id, case_id, provider, action, idempotency_key, request_sha256)
    values (tf.id('wsA'), tf.id('caseA2'), 'resend', 'send_notification', 'case-A2:notify:v1', digest('req','sha256'));
  perform tf.must_fail('T07b duplicate integration interaction (one business effect per key)',
    format('insert into integration_interactions (workspace_id, case_id, provider, action, idempotency_key, request_sha256) values (%L,%L,%L,%L,%L,digest(%L,%L))',
      tf.id('wsA'), tf.id('caseA2'), 'resend', 'send_notification', 'case-A2:notify:v1', 'req', 'sha256'), '23505');
  perform tf.expect('T07c usage event counted once (first)', app.record_usage(tf.id('wsA'), 'evt-1', 'documents', 1), true);
  perform tf.expect('T07d usage event replay ignored', app.record_usage(tf.id('wsA'), 'evt-1', 'documents', 1), false);
  perform tf.expect('T07e counter = 1', (select value from usage_counters where workspace_id = tf.id('wsA') and metric = 'documents')::int, 1);
end $$;

-- ---------------- T08 version immutability ----------------
do $$
declare v_def uuid := gen_random_uuid(); v_v1 uuid := gen_random_uuid(); v_v2 uuid := gen_random_uuid();
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  insert into workflow_definitions (id, workspace_id, key, name) values (v_def, tf.id('wsA'), 'onboarding', 'Onboarding');
  insert into workflow_versions (id, workspace_id, definition_id, version_number, config_json) values (v_v1, tf.id('wsA'), v_def, 1, '{"nodes":[]}');
  insert into workflow_nodes (workspace_id, version_id, node_key, node_type) values (tf.id('wsA'), v_v1, 'start', 'trigger');
  perform tf.must_fail('T08a active pointer to a DRAFT version', format('update workflow_definitions set active_version_id = %L where id = %L', v_v1, v_def), '23514');
  update workflow_versions set status = 'published', published_at = now(), config_sha256 = digest('c1','sha256') where id = v_v1;
  update workflow_definitions set active_version_id = v_v1 where id = v_def;
  raise notice 'PASS  T08b draft -> published, active pointer set';
  perform tf.must_fail('T08c edit published config', format('update workflow_versions set config_json = %L where id = %L', '{"x":1}', v_v1), '55000');
  perform tf.must_fail('T08d add node to published version', format('insert into workflow_nodes (workspace_id, version_id, node_key, node_type) values (%L,%L,%L,%L)', tf.id('wsA'), v_v1, 'n2', 'approval'), '55000');
  perform tf.must_fail('T08e delete published version', format('delete from workflow_versions where id = %L', v_v1), '55000');
  perform tf.must_fail('T08f edit field of a published form version', format('insert into form_fields (workspace_id, version_id, field_key, label, field_type) values (%L,%L,%L,%L,%L)', tf.id('wsA'), tf.id('fvA'), 'x', 'X', 'text'), '55000');
  insert into workflow_versions (id, workspace_id, definition_id, version_number, config_json, status, published_at, config_sha256)
    values (v_v2, tf.id('wsA'), v_def, 2, '{"nodes":["a"]}', 'published', now(), digest('c2','sha256'));
  update workflow_definitions set active_version_id = v_v2 where id = v_def;
  update workflow_definitions set active_version_id = v_v1 where id = v_def;
  raise notice 'PASS  T08g rollback = moving pointer back to v1 (history untouched)';
  update workflow_versions set status = 'retired' where id = v_v2;
  perform tf.must_fail('T08h retired version cannot return to draft', format('update workflow_versions set status = %L where id = %L', 'draft', v_v2), '55000');
end $$;

-- ---------------- T09-T10 data protection + state machine ----------------
do $$
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T09a highly sensitive value stored as plaintext',
    format('insert into case_values (workspace_id, case_id, field_key, sensitivity, value_json) values (%L,%L,%L,%L,%L)', tf.id('wsA'), tf.id('caseA1'), 'aadhaar', 'highly_sensitive', '"123412341234"'), '23514');
  perform tf.must_pass('T09b highly sensitive value accepted only as ciphertext + key id',
    format('insert into case_values (workspace_id, case_id, field_key, sensitivity, value_ciphertext, key_id, masked_preview) values (%L,%L,%L,%L,%L,%L,%L)', tf.id('wsA'), tf.id('caseA1'), 'aadhaar', 'highly_sensitive', '\xdeadbeef', 'k1', 'XXXX-XXXX-1234'));
  perform tf.must_fail('T09c credential reference that looks like a pasted secret',
    format('insert into integration_connections (workspace_id, provider, name, credential_ref) values (%L,%L,%L,%L)', tf.id('wsA'), 'resend', 'bad', 'sk_live_abc123'), '23514');
  perform tf.must_fail('T10a illegal case transition draft -> completed', format('update cases set status = %L where id = %L', 'completed', tf.id('caseA1')), '23514');
  perform tf.must_pass('T10b legal case transition draft -> submitted', format('update cases set status = %L, submitted_at = now() where id = %L', 'submitted', tf.id('caseA1')));
  perform tf.must_fail('T10c case_values frozen after submission (edit)', format('update case_values set masked_preview = %L where case_id = %L', 'x', tf.id('caseA1')), '55000');
  perform tf.must_pass('T10d correction after submission = NEW revision',
    format('insert into case_values (workspace_id, case_id, field_key, revision, sensitivity, value_json) values (%L,%L,%L,2,%L,%L)', tf.id('wsA'), tf.id('caseA1'), 'full_name', 'internal', '"Asha K"'));
  perform tf.must_fail('T10e illegal AI job transition created -> running', format('update ai_jobs set status = %L where id = %L', 'running', tf.id('job1')), '23514');
end $$;

-- ---------------- T11 no sensitive action without approval ----------------
do $$
declare v_a uuid;
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.must_fail('T11a sensitive case -> action_executing with NO approval', format('update cases set status = %L where id = %L', 'action_executing', tf.id('caseA2')), '23514');
  insert into approvals (workspace_id, case_id, workflow_step_key, approver_user_id) values (tf.id('wsA'), tf.id('caseA2'), 'hr_approval', tf.id('u1')) returning id into v_a;
  perform tf.must_fail('T11b ... with only a PENDING approval', format('update cases set status = %L where id = %L', 'action_executing', tf.id('caseA2')), '23514');
  update approvals set decision = 'approved', decided_at = now() where id = v_a;
  perform tf.must_pass('T11c ... after approval is granted', format('update cases set status = %L where id = %L', 'action_executing', tf.id('caseA2')));
  perform tf.must_fail('T11d a decided approval cannot be edited', format('update approvals set decision = %L, reason = %L, decided_at = now() where id = %L', 'rejected', 'changed my mind', v_a), '55000');
  perform tf.must_fail('T11e rejection requires a reason', format('insert into approvals (workspace_id, case_id, workflow_step_key, approver_user_id, decision, decided_at, round) values (%L,%L,%L,%L,%L,now(),2)', tf.id('wsA'), tf.id('caseA2'), 'hr_approval', tf.id('u3'), 'rejected'), '23514');
end $$;

-- ---------------- T12 delegation overlap, policy freeze, lease consistency ----------------
do $$
declare v_pol uuid := gen_random_uuid();
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  insert into approval_delegations (workspace_id, delegator_user_id, delegate_user_id, valid_during)
    values (tf.id('wsA'), tf.id('u1'), tf.id('u3'), tstzrange(now(), now() + interval '7 days'));
  perform tf.must_fail('T12a overlapping delegation windows for the same delegator',
    format('insert into approval_delegations (workspace_id, delegator_user_id, delegate_user_id, valid_during) values (%L,%L,%L,tstzrange(now() + interval %L, now() + interval %L))',
       tf.id('wsA'), tf.id('u1'), tf.id('u3'), '3 days', '10 days'), '23P01');
  insert into routing_policies (id, workspace_id, policy_version) values (v_pol, tf.id('wsA'), 'onboarding-v3');
  perform tf.must_fail('T12b sensitive action can never be auto-proceed',
    format('insert into routing_policy_thresholds (workspace_id, policy_id, doc_class, action_risk, min_confidence, auto_proceed_allowed) values (%L,%L,%L,%L,0.9,true)', tf.id('wsA'), v_pol, 'identity', 'sensitive'), '23514');
  insert into routing_policy_thresholds (workspace_id, policy_id, doc_class, action_risk, min_confidence, auto_proceed_allowed) values (tf.id('wsA'), v_pol, 'education', 'low', 0.90, true);
  update routing_policies set status = 'active', activated_at = now() where id = v_pol;
  perform tf.must_fail('T12c thresholds of an ACTIVE policy are frozen',
    format('update routing_policy_thresholds set min_confidence = 0.10 where policy_id = %L', v_pol), '55000');
  update ai_jobs set status = 'queued' where id = tf.id('job1');
  perform tf.must_fail('T12d status "claimed" without a lease is rejected', format('update ai_jobs set status = %L where id = %L', 'claimed', tf.id('job1')), '23514');
end $$;
