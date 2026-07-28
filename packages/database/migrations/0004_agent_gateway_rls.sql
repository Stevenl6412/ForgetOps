-- Task 7: pre-authenticated agent lookup and tenant-scoped gateway access.
-- The lookup is intentionally narrow: it is the only cross-tenant read made
-- before the agent message can establish a tenant RLS context.

grant select (id, environment_id, public_signing_key, signing_key_id,
              protocol_version, status, last_sequence)
  on agents to forgetops_bootstrap;

create table if not exists agent_transport_sessions (
  agent_id text primary key references agents(id) on delete cascade,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  transport text not null check (transport in ('websocket', 'polling')),
  session_id text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists agent_transport_sessions_tenant_idx
  on agent_transport_sessions(tenant_id, environment_id);

create or replace function validate_agent_transport_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $function$
declare
  expected_tenant_id text;
  expected_environment_id text;
begin
  select p.tenant_id, a.environment_id
    into expected_tenant_id, expected_environment_id
  from public.agents a
  join public.environments e on e.id = a.environment_id
  join public.projects p on p.id = e.project_id
  where a.id = new.agent_id;

  if expected_tenant_id is null
     or expected_tenant_id <> new.tenant_id
     or expected_environment_id <> new.environment_id then
    raise exception 'agent transport scope does not match agent'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

alter function validate_agent_transport_scope() owner to forgetops_bootstrap;
revoke all on function validate_agent_transport_scope() from public;

drop trigger if exists agent_transport_scope_validation
  on agent_transport_sessions;
create trigger agent_transport_scope_validation
before insert or update on agent_transport_sessions
for each row execute function validate_agent_transport_scope();

alter table agent_transport_sessions enable row level security;
alter table agent_transport_sessions force row level security;
drop policy if exists agent_transport_sessions_tenant_isolation
  on agent_transport_sessions;
create policy agent_transport_sessions_tenant_isolation
  on agent_transport_sessions
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete on agent_transport_sessions to forgetops_app;

create or replace function lookup_agent_identity(p_agent_id text)
returns table (
  agent_id text,
  tenant_id text,
  environment_id text,
  public_signing_key text,
  signing_key_id text,
  protocol_version text,
  status text,
  last_sequence text
)
language sql
security definer
set search_path = pg_catalog, public
set row_security = off
as $function$
  select
    a.id,
    p.tenant_id,
    a.environment_id,
    a.public_signing_key,
    a.signing_key_id,
    a.protocol_version,
    a.status,
    a.last_sequence
  from public.agents a
  join public.environments e on e.id = a.environment_id
  join public.projects p on p.id = e.project_id
  where a.id = p_agent_id
  limit 1
$function$;

alter function lookup_agent_identity(text) owner to forgetops_bootstrap;
revoke all on function lookup_agent_identity(text) from public;
grant execute on function lookup_agent_identity(text) to forgetops_app;
