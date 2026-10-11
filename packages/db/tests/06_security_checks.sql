-- =====================================================================
-- Phase 2 hand-written security checks (app role, RLS, append-only, audit chain).
-- Run AFTER migrations on the TEST database:  pnpm --filter @formiva/db run db:security-check   (or psql -v ON_ERROR_STOP=1 -f this file)
-- Runs as the migration admin, seeds two synthetic workspaces, checks as formiva_app, then ROLLS BACK (leaves no data).
-- =====================================================================
begin;
insert into workspaces (name, slug, status) values ('Sec One','sec-chk-one','active'),('Sec Two','sec-chk-two','active');
do $$
declare w1 uuid; w2 uuid; n bigint; checks int := 0;
begin
  select id into w1 from workspaces where slug = 'sec-chk-one';
  select id into w2 from workspaces where slug = 'sec-chk-two';
  perform set_config('app.workspace_id', w1::text, true); insert into roles (workspace_id,name,is_system) values (w1,'r_one',false); perform app.audit('sec.one','t','1'); perform app.audit('sec.one','t','2');
  perform set_config('app.workspace_id', w2::text, true); insert into roles (workspace_id,name,is_system) values (w2,'r_two',false); perform app.audit('sec.two','t','1');
  perform set_config('app.workspace_id', '', true);

  -- role properties
  assert not exists (select 1 from pg_roles where rolname = 'formiva_app' and (rolsuper or rolbypassrls or rolcanlogin)), 'formiva_app must be NOSUPERUSER NOBYPASSRLS NOLOGIN'; checks := checks + 1;
  assert not exists (select 1 from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname in ('public','app','ops') and c.relkind in ('r','p') and pg_get_userbyid(c.relowner) = 'formiva_app'), 'formiva_app must not own tables'; checks := checks + 1;
  -- every tenant table has ENABLED + FORCED RLS (allowlist: pre-membership table reachable only through definer functions)
  assert not exists (select 1 from pg_class c join pg_namespace s on s.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='workspace_id' and not a.attisdropped
     where s.nspname='public' and c.relkind in ('r','p') and c.relname <> 'workspace_bootstrap_idempotency' and not (c.relrowsecurity and c.relforcerowsecurity)), 'tenant table without forced RLS'; checks := checks + 1;
  assert not has_table_privilege('formiva_app','workspace_bootstrap_idempotency','select,insert,update,delete'), 'app role must have no direct access to bootstrap idempotency table'; checks := checks + 1;

  set local role formiva_app;
  -- no tenant context => zero rows
  select count(*) into n from roles; assert n = 0, 'roles visible without context'; checks := checks + 1;
  select count(*) into n from audit_events; assert n = 0, 'audit_events visible without context'; checks := checks + 1;
  -- context = workspace one: sees own, never workspace two
  perform set_config('app.workspace_id', w1::text, true);
  select count(*) into n from roles where workspace_id = w1; assert n = 1, 'own role rows not visible'; checks := checks + 1;
  select count(*) into n from roles where workspace_id = w2; assert n = 0, 'foreign roles visible'; checks := checks + 1;
  select count(*) into n from audit_events where workspace_id = w2; assert n = 0, 'foreign audit rows visible'; checks := checks + 1;
  update roles set name = 'hacked' where workspace_id = w2; get diagnostics n = row_count; assert n = 0, 'foreign rows updated'; checks := checks + 1;
  -- cross-tenant insert refused by RLS WITH CHECK
  begin insert into roles (workspace_id,name,is_system) values (w2,'evil',false); assert false, 'cross-tenant insert succeeded';
  exception when insufficient_privilege then checks := checks + 1; end;
  -- append-only by privilege
  begin update audit_events set reason = 'x'; assert false, 'app updated audit';  exception when insufficient_privilege then checks := checks + 1; end;
  begin delete from audit_events;              assert false, 'app deleted audit';  exception when insufficient_privilege then checks := checks + 1; end;
  begin truncate audit_events;                 assert false, 'app truncated audit'; exception when insufficient_privilege then checks := checks + 1; end;
  reset role;
  -- append-only by trigger, even for the migration admin
  begin update audit_events set reason = 'tamper'; assert false, 'admin updated audit'; exception when object_not_in_prerequisite_state then checks := checks + 1; end;
  begin delete from audit_events;                 assert false, 'admin deleted audit'; exception when object_not_in_prerequisite_state then checks := checks + 1; end;
  -- audit hash chain
  assert (select ok from app.verify_audit_chain(w1)), 'audit chain broken ws1'; checks := checks + 1;
  assert (select ok from app.verify_audit_chain(w2)), 'audit chain broken ws2'; checks := checks + 1;
  raise notice 'PASS  % security checks', checks;
end $$;
rollback;
