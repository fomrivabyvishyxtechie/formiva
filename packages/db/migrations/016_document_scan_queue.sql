-- 016_document_scan_queue.sql : scanner worker claim (Prompt 3.3b, ADR-25)
-- Documents wait in case_documents itself (status pending_upload/uploaded); no separate job table.
alter table case_documents add column scan_attempts integer not null default 0;
alter table case_documents add column scan_lease_until timestamptz;
alter table case_documents add column next_scan_at timestamptz not null default now();
create index case_documents_scan_queue_idx on case_documents (next_scan_at)
  where status in ('pending_upload','uploaded');

-- The scanner works across tenants, so only the claim bypasses RLS (same pattern as ops.claim_next_ai_job).
-- Each claim pushes next_scan_at out with a growing delay, so a file that has not arrived yet is not polled in a tight loop.
create or replace function ops.claim_next_document_scan(p_lease_seconds integer default 300)
returns table (document_id uuid, ws_id uuid, case_id uuid, bucket text, object_key text, mime_type text,
               size_bytes bigint, attempts integer, created_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  select d.id into v_id from case_documents d
   where d.status in ('pending_upload','uploaded') and d.deleted_at is null
     and d.next_scan_at <= now()
     and (d.scan_lease_until is null or d.scan_lease_until < now())
   order by d.next_scan_at, d.created_at
   for update skip locked limit 1;
  if v_id is null then return; end if;
  return query
    update case_documents d
       set scan_lease_until = now() + make_interval(secs => p_lease_seconds),
           scan_attempts = d.scan_attempts + 1,
           next_scan_at = now() + least(make_interval(secs => 30 * (2 ^ least(d.scan_attempts, 6))::integer), interval '1 hour')
     where d.id = v_id
    returning d.id, d.workspace_id, d.case_id, d.bucket, d.object_key, d.mime_type, d.size_bytes, d.scan_attempts, d.created_at;
end $$;

grant select, update on case_documents to formiva_definer;
alter function ops.claim_next_document_scan(integer) owner to formiva_definer;
revoke all on function ops.claim_next_document_scan(integer) from public;
grant execute on function ops.claim_next_document_scan(integer) to formiva_worker;
