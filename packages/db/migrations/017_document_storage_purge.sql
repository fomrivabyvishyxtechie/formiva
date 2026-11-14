-- 017_document_storage_purge.sql : delete the stored file of a removed document (ADR-29)
-- Removing a document only marks the row 'deleted'. The scanner worker now also deletes the stored object
-- (from both buckets) and records when it did. Additive only; nothing existing changes.
alter table case_documents add column storage_purged_at timestamptz;
alter table case_documents add column storage_purge_after timestamptz not null default now();
create index case_documents_purge_idx on case_documents (storage_purge_after)
  where status = 'deleted' and storage_purged_at is null;

-- Claim one removed document whose file has not been deleted yet. A file is left alone for 10 minutes after removal
-- so a scan that was already running (lease 5 minutes) cannot put it back after the purge. Each claim pushes the
-- next try 10 minutes out, so a failing delete is retried later instead of blocking the queue. Legal hold is never purged.
create or replace function ops.claim_next_document_purge()
returns table (document_id uuid, ws_id uuid, object_key text)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  select d.id into v_id from case_documents d
   where d.status = 'deleted' and d.storage_purged_at is null and d.legal_hold = false
     and d.deleted_at is not null and d.deleted_at < now() - interval '10 minutes'
     and d.storage_purge_after <= now()
   order by d.storage_purge_after
   for update skip locked limit 1;
  if v_id is null then return; end if;
  return query
    update case_documents d
       set storage_purge_after = now() + interval '10 minutes'
     where d.id = v_id
    returning d.id, d.workspace_id, d.object_key;
end $$;

alter function ops.claim_next_document_purge() owner to formiva_definer;
revoke all on function ops.claim_next_document_purge() from public;
grant execute on function ops.claim_next_document_purge() to formiva_worker;
