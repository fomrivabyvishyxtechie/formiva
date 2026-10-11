create table workspace_invitations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id),
  role_id         uuid not null,
  email           citext not null,
  token_hash      bytea not null unique check (octet_length(token_hash) = 32),
  expires_at      timestamptz not null,
  created_by      uuid not null references users(id),
  created_at      timestamptz not null default now(),
  foreign key (role_id, workspace_id) references roles(id, workspace_id)
);

create index workspace_invitations_token_idx on workspace_invitations (token_hash);
create index workspace_invitations_workspace_idx on workspace_invitations (workspace_id);

call app.tenantize('workspace_invitations');
call app.with_updated_at('workspace_invitations');
