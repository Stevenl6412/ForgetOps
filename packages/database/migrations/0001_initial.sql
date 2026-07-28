do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'forgetops_app') then
    create role forgetops_app nologin;
  end if;
  execute format('grant forgetops_app to %I', current_user);
end;
$$;

create table tenants (
  id text primary key,
  name text not null,
  plan text not null check (plan in ('trial', 'starter', 'team')),
  created_at timestamptz not null default now()
);

create table projects (
  id text primary key,
  tenant_id text not null references tenants(id),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now()
);

create table environments (
  id text primary key,
  project_id text not null references projects(id),
  kind text not null check (kind in ('staging', 'production')),
  status text not null check (status in ('active', 'disabled')),
  subject_hash_key_version integer not null check (subject_hash_key_version > 0),
  subject_canonicalization_version integer not null default 1
    check (subject_canonicalization_version > 0),
  created_at timestamptz not null default now()
);

create unique index environments_project_kind_uq
  on environments(project_id, kind);

create table agent_pairing_tokens (
  id text primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  token_hash text not null,
  allow_replacement boolean not null default false,
  created_by_actor_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index agent_pairing_tokens_environment_idx
  on agent_pairing_tokens(environment_id);

create unique index agent_pairing_tokens_hash_uq
  on agent_pairing_tokens(token_hash);

create table agents (
  id text primary key,
  environment_id text not null references environments(id),
  public_signing_key text not null,
  public_encryption_key text not null,
  version text not null,
  protocol_version text not null,
  instance_fingerprint text not null,
  status text not null check (
    status in ('pairing', 'online', 'offline', 'outdated', 'revoked')
  ),
  last_seen_at timestamptz,
  last_sequence text not null,
  last_control_sequence text not null default '0',
  created_at timestamptz not null default now()
);

create unique index agents_one_active_per_environment_uq
  on agents(environment_id)
  where status in ('pairing', 'online', 'offline', 'outdated');

create table agent_message_receipts (
  agent_id text not null references agents(id),
  message_id text not null,
  sequence text not null,
  received_at timestamptz not null,
  primary key (agent_id, message_id)
);

create unique index agent_message_receipts_agent_sequence_uq
  on agent_message_receipts(agent_id, sequence);

create index agent_message_receipts_received_at_idx
  on agent_message_receipts(received_at);

create table privacy_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  type text not null check (type in ('delete', 'export')),
  source text not null check (source in ('admin', 'privacy_portal', 'api')),
  subject_hash text,
  subject_hash_key_version integer check (
    subject_hash_key_version is null or subject_hash_key_version > 0
  ),
  subject_canonicalization_version integer check (
    subject_canonicalization_version is null
    or subject_canonicalization_version > 0
  ),
  duplicate_override boolean not null default false,
  duplicate_of_request_id text references privacy_requests(id),
  current_attempt_id text,
  status text not null check (status in (
    'created',
    'identity_verification_pending',
    'identity_verified',
    'planning',
    'awaiting_approval',
    'execution_authorized',
    'executing',
    'needs_review',
    'completed',
    'partially_completed',
    'failed',
    'cancelled'
  )),
  policy_version integer not null check (policy_version > 0),
  deadline_at timestamptz not null,
  created_by_actor_id text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  version integer not null check (version > 0)
);

create unique index privacy_requests_one_active_subject_type_uq
  on privacy_requests(environment_id, subject_hash, type)
  where subject_hash is not null
    and duplicate_override = false
    and status not in ('completed', 'cancelled');

create table execution_attempts (
  id text primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  request_id text not null references privacy_requests(id),
  attempt_number integer not null check (attempt_number > 0),
  kind text not null check (kind in ('initial', 'retry')),
  plan_id text not null,
  plan_version integer not null check (plan_version > 0),
  plan_fingerprint text not null,
  allowed_step_ids jsonb not null check (
    jsonb_typeof(allowed_step_ids) = 'array'
    and jsonb_array_length(allowed_step_ids) > 0
  ),
  status text not null check (status in (
    'planned',
    'awaiting_approval',
    'authorized',
    'running',
    'succeeded',
    'partially_succeeded',
    'failed',
    'needs_review',
    'cancelled'
  )),
  created_at timestamptz not null,
  completed_at timestamptz,
  check (
    (status in (
      'succeeded',
      'partially_succeeded',
      'failed',
      'needs_review',
      'cancelled'
    )) = (completed_at is not null)
  )
);

create unique index execution_attempts_request_number_uq
  on execution_attempts(request_id, attempt_number);

create unique index execution_attempts_id_request_uq
  on execution_attempts(id, request_id);

alter table privacy_requests
  add constraint privacy_requests_current_attempt_fk
  foreign key (current_attempt_id, id)
  references execution_attempts(id, request_id)
  deferrable initially deferred;

create table agent_jobs (
  id text primary key,
  tenant_id text not null references tenants(id),
  request_id text not null references privacy_requests(id),
  environment_id text not null references environments(id),
  kind text not null check (
    kind in (
      'bind_subject',
      'plan',
      'execute',
      'lease_execution',
      'wrap_export_key',
      'cancel',
      'health_check'
    )
  ),
  plan_version integer check (plan_version is null or plan_version > 0),
  payload_ciphertext text,
  authorization_payload text,
  available_at timestamptz not null,
  expires_at timestamptz not null,
  leased_by_agent_id text references agents(id),
  lease_expires_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index agent_jobs_available_idx
  on agent_jobs(environment_id, available_at)
  where completed_at is null;

create table idempotency_records (
  tenant_id text not null references tenants(id),
  scope text not null check (length(scope) > 0),
  actor_id text not null check (length(actor_id) > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  request_hash text not null check (length(request_hash) > 0),
  response_status integer check (
    response_status is null or response_status between 100 and 599
  ),
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create unique index idempotency_records_scope_actor_key_uq
  on idempotency_records(tenant_id, scope, actor_id, idempotency_key);

create table audit_chain_heads (
  tenant_id text not null references tenants(id),
  environment_id text primary key references environments(id),
  sequence bigint not null default 0 check (sequence >= 0),
  event_hash text,
  check ((sequence = 0) = (event_hash is null))
);

create table audit_events (
  id uuid primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  sequence bigint not null check (sequence > 0),
  request_id text references privacy_requests(id),
  actor_type text not null check (
    actor_type in ('user', 'agent', 'system')
  ),
  actor_id text not null,
  action text not null,
  metadata jsonb not null,
  previous_event_hash text,
  event_hash text not null,
  created_at timestamptz not null
);

create unique index audit_events_environment_sequence_uq
  on audit_events(environment_id, sequence);

create unique index audit_events_environment_hash_uq
  on audit_events(environment_id, event_hash);

create table outbox_events (
  id uuid primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  aggregate_id text not null references privacy_requests(id),
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index outbox_events_unpublished_occurred_at_idx
  on outbox_events(occurred_at)
  where published_at is null;

create function reject_execution_attempt_history_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'execution_attempts are append-only'
      using errcode = '55000';
  end if;
  if old.completed_at is not null then
    raise exception 'completed execution_attempts are immutable'
      using errcode = '55000';
  end if;
  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.environment_id is distinct from old.environment_id
    or new.request_id is distinct from old.request_id
    or new.attempt_number is distinct from old.attempt_number
    or new.kind is distinct from old.kind
    or new.plan_id is distinct from old.plan_id
    or new.plan_version is distinct from old.plan_version
    or new.plan_fingerprint is distinct from old.plan_fingerprint
    or new.allowed_step_ids is distinct from old.allowed_step_ids
    or new.created_at is distinct from old.created_at
  then
    raise exception 'execution_attempt authorization is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger execution_attempts_immutable
before update or delete on execution_attempts
for each row execute function reject_execution_attempt_history_mutation();

create function reject_audit_event_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events are append-only' using errcode = '55000';
end;
$$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function reject_audit_event_mutation();

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenants_tenant_isolation on tenants
  for all
  using (id = current_setting('app.tenant_id', true))
  with check (id = current_setting('app.tenant_id', true));

alter table projects enable row level security;
alter table projects force row level security;
create policy projects_tenant_isolation on projects
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table environments enable row level security;
alter table environments force row level security;
create policy environments_tenant_isolation on environments
  for all
  using (exists (
    select 1
    from projects
    where projects.id = environments.project_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ))
  with check (exists (
    select 1
    from projects
    where projects.id = environments.project_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ));

alter table agent_pairing_tokens enable row level security;
alter table agent_pairing_tokens force row level security;
create policy agent_pairing_tokens_tenant_isolation on agent_pairing_tokens
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table agents enable row level security;
alter table agents force row level security;
create policy agents_tenant_isolation on agents
  for all
  using (exists (
    select 1
    from environments
    join projects on projects.id = environments.project_id
    where environments.id = agents.environment_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ))
  with check (exists (
    select 1
    from environments
    join projects on projects.id = environments.project_id
    where environments.id = agents.environment_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ));

alter table agent_message_receipts enable row level security;
alter table agent_message_receipts force row level security;
create policy agent_message_receipts_tenant_isolation on agent_message_receipts
  for all
  using (exists (
    select 1
    from agents
    join environments on environments.id = agents.environment_id
    join projects on projects.id = environments.project_id
    where agents.id = agent_message_receipts.agent_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ))
  with check (exists (
    select 1
    from agents
    join environments on environments.id = agents.environment_id
    join projects on projects.id = environments.project_id
    where agents.id = agent_message_receipts.agent_id
      and projects.tenant_id = current_setting('app.tenant_id', true)
  ));

alter table privacy_requests enable row level security;
alter table privacy_requests force row level security;
create policy privacy_requests_tenant_isolation on privacy_requests
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table execution_attempts enable row level security;
alter table execution_attempts force row level security;
create policy execution_attempts_tenant_isolation on execution_attempts
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table agent_jobs enable row level security;
alter table agent_jobs force row level security;
create policy agent_jobs_tenant_isolation on agent_jobs
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table idempotency_records enable row level security;
alter table idempotency_records force row level security;
create policy idempotency_records_tenant_isolation on idempotency_records
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table audit_chain_heads enable row level security;
alter table audit_chain_heads force row level security;
create policy audit_chain_heads_tenant_isolation on audit_chain_heads
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_events_tenant_isolation on audit_events
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

alter table outbox_events enable row level security;
alter table outbox_events force row level security;
create policy outbox_events_tenant_isolation on outbox_events
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant usage on schema public to forgetops_app;
grant select, insert, update, delete on
  tenants,
  projects,
  environments,
  agent_pairing_tokens,
  agents,
  agent_message_receipts,
  privacy_requests,
  agent_jobs,
  idempotency_records,
  audit_chain_heads,
  outbox_events
to forgetops_app;
grant select, insert, update on execution_attempts to forgetops_app;
grant select, insert on audit_events to forgetops_app;
