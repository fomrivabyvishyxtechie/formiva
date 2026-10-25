-- 015_upload_requests.sql : a document row now exists BEFORE its file does (Prompt 3.3a, ADR-24)
-- The scanner worker (3.3b) fills in sha256 after it has read the stored object.
alter table case_documents alter column sha256 drop not null;
alter table case_documents add constraint case_documents_sha_after_upload
  check (sha256 is not null or status in ('pending_upload','uploaded','quarantined','rejected','deleted'));

alter table case_documents add column slot_key text;
alter table case_documents add column idempotency_key_hash bytea
  check (idempotency_key_hash is null or octet_length(idempotency_key_hash) = 32);

-- One upload request per (case, idempotency key): a retry gets the same document back.
create unique index case_documents_idempotency_idx
  on case_documents (case_id, idempotency_key_hash) where idempotency_key_hash is not null;
