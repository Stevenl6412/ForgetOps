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
  status text not null check (status in ('pairing', 'online', 'offline', 'outdated', 'revoked')),
  last_seen_at timestamptz,
  last_sequence text not null,
  created_at timestamptz not null default now()
);

create unique index agents_one_active_per_environment_uq
  on agents(environment_id)
  where status in ('pairing', 'online', 'offline', 'outdated');

create table privacy_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  type text not null check (type in ('delete', 'export')),
  source text not null check (source in ('admin', 'privacy_portal', 'api')),
  subject_hash text,
  status text not null check (status in (
    'created',
    'identity_verification_pending',
    'identity_verified',
    'planning',
    'awaiting_approval',
    'execution_authorized',
    'executing',
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
  version integer not null check (version > 0),
  idempotency_key text not null
);

create unique index privacy_requests_idempotency_uq
  on privacy_requests(environment_id, idempotency_key);

create unique index privacy_requests_one_active_subject_type_uq
  on privacy_requests(environment_id, subject_hash, type)
  where subject_hash is not null
    and status not in ('completed', 'partially_completed', 'failed', 'cancelled');

create table audit_events (
  id uuid primary key,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  request_id text references privacy_requests(id),
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text not null,
  action text not null,
  metadata jsonb not null,
  previous_event_hash text,
  event_hash text not null,
  created_at timestamptz not null
);

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

create function reject_audit_event_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events are append-only' using errcode = '55000';
end;
$$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function reject_audit_event_mutation();
