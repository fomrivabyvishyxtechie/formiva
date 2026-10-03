#!/bin/bash
# 12 parallel worker sessions race to claim 10 queued jobs: every job must be claimed exactly once.
export PGOPTIONS='-c client_min_messages=warning'
su postgres -c "psql -q -d formiva_test" <<'SQL'
select app.set_context((select v from tf.ids where k='wsA'), (select v from tf.ids where k='u1'));
delete from tf.ids where k like 'race%';
SQL
su postgres -c "psql -q -d formiva_test -v ON_ERROR_STOP=1" <<'SQL'
begin;
select app.set_context((select v from tf.ids where k='wsA'), null);
update ai_jobs set status='cancelled' where status in ('queued','retrying');
insert into ai_jobs (workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version, status)
select (select v from tf.ids where k='wsA'), (select v from tf.ids where k='caseA1'), (select v from tf.ids where k='docA1'),
       'race-'||g, digest('doc','sha256'), 'p', 'queued' from generate_series(1,10) g;
commit;
create table if not exists tf.race_claims (job_id uuid, worker text);
truncate tf.race_claims; grant all on tf.race_claims to public;
SQL
for i in $(seq 1 12); do
  ( su postgres -c "psql -q -tA -d formiva_test -c \"set role formiva_worker; insert into tf.race_claims select job_id, 'w$i' from ops.claim_next_ai_job('w$i', 60);\"" >/dev/null 2>&1 ) &
done
wait
su postgres -c "psql -tA -d formiva_test" <<'SQL'
select 'claims=' || count(*) || ' distinct_jobs=' || count(distinct job_id) || ' (expected 10 / 10)' from tf.race_claims;
SQL
