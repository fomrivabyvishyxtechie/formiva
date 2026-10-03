-- =====================================================================
-- 007_government_documents.sql : government-issued document policy
--  * catalog of document subtypes (which are government-issued, default sensitivity)
--  * per-workspace collection policy (what the employer chooses to collect, why, how)
--  * enforcement: fail closed when a government document has no policy; ID documents are always
--    highly sensitive; Aadhaar policies must require a masked copy; purpose is mandatory
-- Formiva READS documents and extracts fields. It does NOT verify authenticity against government
-- databases (UIDAI, NSDL/Protean, DigiLocker, Passport Seva). Format checks are offline only.
-- =====================================================================
create table document_subtypes (
  key                 text primary key,
  doc_class           text not null check (doc_class in ('identity','address','education','employment','bank','tax','photo','other','unknown')),
  government_issued   boolean not null,
  default_sensitivity text not null check (default_sensitivity in ('public','internal','confidential','sensitive','highly_sensitive')),
  description         text not null
);

insert into document_subtypes (key, doc_class, government_issued, default_sensitivity, description) values
 ('aadhaar','identity',true,'highly_sensitive','Aadhaar card, e-Aadhaar or letter. Collect a MASKED copy (first 8 digits hidden); never store or show the full number.'),
 ('pan','identity',true,'highly_sensitive','PAN card or allotment letter. Number stored as ciphertext; last four digits displayed.'),
 ('passport','identity',true,'highly_sensitive','Passport data page. Machine-readable zone check digits can be verified offline (format only).'),
 ('driving_licence','identity',true,'highly_sensitive','Driving licence issued by a state transport authority.'),
 ('voter_id','identity',true,'highly_sensitive','Election photo identity card (EPIC).'),
 ('uan_epf','employment',true,'sensitive','Universal Account Number card, EPFO passbook or declaration form.'),
 ('esic','employment',true,'sensitive','ESIC insurance number or card.'),
 ('itr_ack','tax',true,'sensitive','Income-tax return acknowledgement issued by the tax department.'),
 ('caste_community_certificate','identity',true,'highly_sensitive','Caste or community certificate: special-category personal data. Collect only for a specific, documented lawful need.'),
 ('police_verification','other',true,'highly_sensitive','Police verification or clearance certificate. Collect only where the employer has a documented need.'),
 ('form16','tax',false,'sensitive','Form 16 / TDS certificate from a previous employer.'),
 ('education_certificate','education',false,'sensitive','Marksheet, degree or diploma from a board, university or institute.'),
 ('address_proof','address',false,'sensitive','Utility bill, rent agreement or other address proof.'),
 ('bank_cancelled_cheque','bank',false,'highly_sensitive','Cancelled cheque showing account and IFSC.'),
 ('bank_passbook','bank',false,'highly_sensitive','Bank passbook or statement page.'),
 ('payslip','employment',false,'sensitive','Salary slip from a previous employer.'),
 ('experience_letter','employment',false,'sensitive','Experience letter from a previous employer.'),
 ('relieving_letter','employment',false,'sensitive','Relieving letter from a previous employer.'),
 ('offer_letter','employment',false,'sensitive','Offer or appointment letter.'),
 ('photo','photo',false,'sensitive','Passport-size photograph.'),
 ('other','other',false,'sensitive','Other document accepted by the employer.'),
 ('unknown','unknown',false,'sensitive','Not yet classified.');

alter table case_documents add column doc_subtype text references document_subtypes(key);
alter table ai_results     add column document_subtype text references document_subtypes(key);
create index case_documents_subtype_idx on case_documents (workspace_id, doc_subtype);

create table document_type_policies (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id),
  doc_subtype       text not null references document_subtypes(key),
  collect_mode      text not null default 'not_collected' check (collect_mode in ('not_collected','optional','required')),
  require_masked    boolean not null default false,
  store_file        boolean not null default true,       -- false = extract, review, then delete the file
  retain_days       integer check (retain_days > 0),     -- NULL until counsel/customer decide (decision D-6)
  reveal_permission text not null default 'document.read_sensitive' references permissions(key),
  purpose           text not null default '',            -- the employer's lawful purpose for collecting this document
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, doc_subtype),
  unique (id, workspace_id),
  check (doc_subtype <> 'aadhaar' or require_masked),                                   -- Aadhaar: masked copy only
  check (collect_mode = 'not_collected' or length(btrim(purpose)) >= 10)                -- purpose limitation
);
call app.with_updated_at('document_type_policies');
call app.tenantize('document_type_policies');

-- Default policy templates for a new workspace. They are starting points: the employer decides.
create or replace function app.seed_document_policies(p_ws uuid) returns integer language plpgsql as $$
declare n integer;
begin
  if p_ws is distinct from app.current_workspace() then raise exception 'context workspace mismatch'; end if;
  insert into document_type_policies (workspace_id, doc_subtype, collect_mode, require_masked, purpose, notes) values
   (p_ws,'aadhaar','optional',true,'Statutory identity or provident-fund onboarding where the employer needs it (masked copy only)','Ask for the masked Aadhaar. Never store or show the full number.'),
   (p_ws,'pan','required',false,'PAN is needed for tax deduction at source and payroll','Number stored as ciphertext; last four displayed.'),
   (p_ws,'passport','optional',false,'Identity or address proof where the employer accepts a passport','Optional alternative to other identity documents.'),
   (p_ws,'driving_licence','optional',false,'Identity or address proof where the employer accepts a driving licence','Optional alternative to other identity documents.'),
   (p_ws,'voter_id','optional',false,'Identity or address proof where the employer accepts a voter ID','Optional alternative to other identity documents.'),
   (p_ws,'uan_epf','optional',false,'Provident-fund account transfer or nomination for the new employee','Only if the employee has an existing UAN.'),
   (p_ws,'esic','optional',false,'Insurance continuity for eligible employees','Only if applicable.'),
   (p_ws,'itr_ack','not_collected',false,'','Not collected by default. Enable only with a documented need.'),
   (p_ws,'caste_community_certificate','not_collected',false,'','Special-category data. Not collected by default; enable only for a specific lawful need.'),
   (p_ws,'police_verification','not_collected',false,'','Not collected by default; enable only where the employer has a documented need.')
  on conflict (workspace_id, doc_subtype) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Enforcement on every document row.
create or replace function app.guard_document_subtype() returns trigger language plpgsql as $$
declare v_cat document_subtypes%rowtype; v_pol document_type_policies%rowtype;
begin
  if new.doc_subtype is null then return new; end if;
  select * into v_cat from document_subtypes where key = new.doc_subtype;
  if new.doc_class <> 'unknown' and new.doc_class <> v_cat.doc_class then
    raise exception 'document class % does not match subtype % (expected %)', new.doc_class, new.doc_subtype, v_cat.doc_class using errcode = '23514';
  end if;
  if v_cat.default_sensitivity = 'highly_sensitive' and new.sensitivity <> 'highly_sensitive' then
    raise exception '% documents must be classified highly_sensitive', new.doc_subtype using errcode = '23514';
  end if;
  select * into v_pol from document_type_policies where workspace_id = new.workspace_id and doc_subtype = new.doc_subtype;
  if v_cat.government_issued then
    if v_pol.id is null then
      raise exception 'no collection policy exists for government document type % (fail closed)', new.doc_subtype using errcode = '23514';
    end if;
    if v_pol.collect_mode = 'not_collected' then
      raise exception 'this workspace does not collect % documents', new.doc_subtype using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' and new.retain_until is null and v_pol.retain_days is not null then
    new.retain_until := now() + make_interval(days => v_pol.retain_days);
  end if;
  return new;
end $$;
create trigger trg_case_documents_subtype before insert or update of doc_subtype, sensitivity, doc_class on case_documents
  for each row execute function app.guard_document_subtype();

grant select, insert, update on document_type_policies to formiva_app, formiva_worker;
grant select on document_type_policies to formiva_readonly;
grant select on document_subtypes to formiva_app, formiva_worker, formiva_readonly;
grant select, insert, update on document_subtypes to formiva_ops;
