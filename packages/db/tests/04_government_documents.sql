-- Run after 01 and 02 (uses their fixtures). Government-document policy checks.
\set ON_ERROR_STOP on
set client_min_messages = notice;
do $$
declare v_d uuid; v_ret timestamptz; v_exec uuid;
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T20a catalog holds 22 document subtypes', (select count(*) from document_subtypes)::int, 22);
  perform tf.expect('T20b ten subtypes are government-issued', (select count(*) from document_subtypes where government_issued)::int, 10);
  perform tf.must_fail('T21 government document with NO workspace policy is refused (fail closed)',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L)',
      tf.id('wsA'), tf.id('caseA1'), 'b', 'k-pan-0', 'application/pdf', 'x', 'sha256', 'pan', 'highly_sensitive'), '23514');
  perform tf.expect('T22a default policies seeded for the 10 government types', app.seed_document_policies(tf.id('wsA')), 10);
  perform tf.expect('T22b seeding twice changes nothing', app.seed_document_policies(tf.id('wsA')), 0);
  perform tf.must_fail('T23 Aadhaar policy cannot allow an unmasked copy', 'update document_type_policies set require_masked = false where doc_subtype = ''aadhaar''', '23514');
  perform tf.must_fail('T24 collecting a document requires a stated purpose', 'update document_type_policies set purpose = '''' where doc_subtype = ''pan''', '23514');
  perform tf.must_fail('T25a PAN document classified below highly_sensitive is refused',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L)',
      tf.id('wsA'), tf.id('caseA1'), 'b', 'k-pan-1', 'application/pdf', 'x', 'sha256', 'pan', 'sensitive'), '23514');
  perform tf.must_fail('T25b class must match the subtype (a PAN is not an education document)',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, doc_class, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L,%L)',
      tf.id('wsA'), tf.id('caseA1'), 'b', 'k-pan-2', 'application/pdf', 'x', 'sha256', 'pan', 'education', 'highly_sensitive'), '23514');
  perform tf.must_pass('T25c PAN document accepted when policy exists and sensitivity is highly_sensitive',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L)',
      tf.id('wsA'), tf.id('caseA1'), 'b', 'k-pan-3', 'application/pdf', 'x', 'sha256', 'pan', 'highly_sensitive'));
  perform tf.must_fail('T26 caste/community certificate is refused while the policy says not_collected',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L)',
      tf.id('wsA'), tf.id('caseA1'), 'b', 'k-caste-1', 'application/pdf', 'x', 'sha256', 'caste_community_certificate', 'highly_sensitive'), '23514');
  update document_type_policies set retain_days = 30 where doc_subtype = 'pan';
  insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity)
    values (tf.id('wsA'), tf.id('caseA1'), 'b', 'k-pan-4', 'application/pdf', 1, digest('y','sha256'), 'pan', 'highly_sensitive') returning retain_until into v_ret;
  perform tf.expect('T27 retention date defaults from the policy (30 days)', (v_ret between now() + interval '29 days' and now() + interval '31 days'), true);
  -- AI result subtype must exist in the catalog
  insert into ai_executions (workspace_id, ai_job_id, attempt_no) values (tf.id('wsA'), tf.id('job1'), 2) returning id into v_exec;
  perform tf.must_fail('T28 AI result with an unknown subtype is refused',
    format('insert into ai_results (workspace_id, ai_execution_id, document_class, document_subtype, detected_language, confidence, confidence_components, sensitivity, routing_recommendation, schema_version) values (%L,%L,%L,%L,%L,0.9,%L,%L,%L,%L)',
      tf.id('wsA'), v_exec, 'identity', 'not_a_real_type', 'en', '{"model":0.9}', 'highly_sensitive', 'human_review', 'v1'), '23503');
  perform tf.must_pass('T28b AI result with a catalog subtype is accepted',
    format('insert into ai_results (workspace_id, ai_execution_id, document_class, document_subtype, detected_language, confidence, confidence_components, sensitivity, routing_recommendation, schema_version) values (%L,%L,%L,%L,%L,0.9,%L,%L,%L,%L)',
      tf.id('wsA'), v_exec, 'identity', 'pan', 'en', '{"model":0.9}', 'highly_sensitive', 'human_review', 'v1'));
end $$;
do $$
begin
  set local role formiva_app;
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T29a workspace A sees its own 10 policies', (select count(*) from document_type_policies)::int, 10);
  perform app.set_context(tf.id('wsB'), tf.id('u2'));
  perform tf.expect('T29b workspace B sees none of A''s policies', (select count(*) from document_type_policies)::int, 0);
  perform tf.must_fail('T29c runtime role cannot edit the document catalog', 'update document_subtypes set government_issued = false where key = ''aadhaar''', '42501');
  perform tf.must_fail('T29d workspace B cannot document a government type without its own policy',
    format('insert into case_documents (workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256, doc_subtype, sensitivity) values (%L,%L,%L,%L,%L,1,digest(%L,%L),%L,%L)',
      tf.id('wsB'), tf.id('caseB1'), 'b', 'k-b-1', 'application/pdf', 'x', 'sha256', 'aadhaar', 'highly_sensitive'), '23514');
end $$;
\echo GOVERNMENT DOCUMENT TESTS PASSED
