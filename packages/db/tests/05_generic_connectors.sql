-- Run after 01 (uses its fixtures). Generic connector catalog checks.
\set ON_ERROR_STOP on
set client_min_messages = notice;
do $$
begin
  perform app.set_context(tf.id('wsA'), tf.id('u1'));
  perform tf.expect('T30a 12 connector categories exist', (select count(*) from connector_categories)::int, 12);
  perform tf.expect('T30b at least 10 documented free/open connector templates', (select count(*) >= 10 from connector_templates), true);
  perform tf.must_pass('T31 a new connector outside the old fixed list is accepted (ticketing, Zammad)',
    format('insert into integration_connections (workspace_id, provider, name, credential_ref, category) values (%L,%L,%L,%L,%L)',
      tf.id('wsA'), 'zammad_ticketing', 'Support desk', 'ref:zammad-key', 'ticketing'));
  perform tf.must_fail('T32a provider with uppercase letters is rejected', format('insert into integration_connections (workspace_id, provider, name, credential_ref) values (%L,%L,%L,%L)', tf.id('wsA'), 'Zammad', 'x', 'ref:x'), '23514');
  perform tf.must_fail('T32b provider with spaces or symbols is rejected', format('insert into integration_connections (workspace_id, provider, name, credential_ref) values (%L,%L,%L,%L)', tf.id('wsA'), 'hr ms!', 'x', 'ref:x'), '23514');
  perform tf.must_pass('T33 launch adapters still insert under the new free-form check', format('insert into integration_connections (workspace_id, provider, name, credential_ref, category) values (%L,%L,%L,%L,%L)', tf.id('wsA'), 'resend', 'Email', 'ref:resend', 'messaging'));
end $$;
do $$
begin
  set local role formiva_ops;
  perform tf.must_pass('T34a ops role can add a connector template', 'insert into connector_templates (category, name, licence_or_plan, auth_type) values (''hrms'',''Generic HRMS webhook'',''varies'',''webhook_signature'')');
  reset role; set local role formiva_app;
  perform tf.must_fail('T34b runtime app role cannot edit the connector catalog', 'update connector_categories set description = ''x'' where key = ''hrms''', '42501');
end $$;
\echo GENERIC CONNECTOR TESTS PASSED
