-- Task 6: explicit replacement modes, public-key identifiers, and envelope
-- lifecycle primitives. This migration is additive so existing agent rows can
-- be paired again before a later data backfill makes key IDs mandatory.

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'forgetops_bootstrap'
  ) then
    create role forgetops_bootstrap nologin noinherit bypassrls;
  else
    alter role forgetops_bootstrap nologin noinherit bypassrls;
  end if;
end;
$$;

alter table agent_pairing_tokens
  add column if not exists replacement_mode text;

update agent_pairing_tokens
set replacement_mode = case
  when allow_replacement then 'drain'
  else 'none'
end
where replacement_mode is null;

alter table agent_pairing_tokens
  alter column replacement_mode set default 'none',
  alter column replacement_mode set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agent_pairing_tokens_replacement_mode_check'
  ) then
    alter table agent_pairing_tokens
      add constraint agent_pairing_tokens_replacement_mode_check
      check (replacement_mode in ('none', 'drain', 'force'));
  end if;
end;
$$;

alter table agents
  add column if not exists signing_key_id text,
  add column if not exists encryption_key_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'agents_key_id_length_check'
  ) then
    alter table agents
      add constraint agents_key_id_length_check
      check (
        (signing_key_id is null or length(signing_key_id) between 16 and 128)
        and
        (encryption_key_id is null or length(encryption_key_id) between 16 and 128)
      );
  end if;
end;
$$;

alter table agent_jobs
  add column if not exists payload_encryption_key_id text;

create table if not exists subject_envelopes (
  request_id text primary key references privacy_requests(id) on delete cascade,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  ciphertext text not null,
  encryption_key_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists subject_envelopes_environment_active_idx
  on subject_envelopes(environment_id, expires_at)
  where consumed_at is null;

create or replace function validate_subject_envelope_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $function$
declare
  request_tenant_id text;
  request_environment_id text;
begin
  select r.tenant_id, r.environment_id
    into request_tenant_id, request_environment_id
  from public.privacy_requests r
  where r.id = new.request_id;

  if request_tenant_id is null
     or request_tenant_id <> new.tenant_id
     or request_environment_id <> new.environment_id then
    raise exception 'subject envelope scope does not match request'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

do $$
begin
  execute format('grant forgetops_bootstrap to %I', current_user);
end;
$$;

grant select (id, tenant_id, environment_id, token_hash, replacement_mode,
              allow_replacement, created_by_actor_id, created_at, expires_at,
              consumed_at)
  on agent_pairing_tokens to forgetops_bootstrap;
grant select (id, project_id)
  on environments to forgetops_bootstrap;
grant select (id, tenant_id)
  on projects to forgetops_bootstrap;
grant select (id, tenant_id, environment_id)
  on privacy_requests to forgetops_bootstrap;

alter function validate_subject_envelope_scope() owner to forgetops_bootstrap;

drop trigger if exists subject_envelopes_scope_validation on subject_envelopes;
create trigger subject_envelopes_scope_validation
before insert or update on subject_envelopes
for each row execute function validate_subject_envelope_scope();

alter table subject_envelopes enable row level security;
alter table subject_envelopes force row level security;

drop policy if exists subject_envelopes_tenant_isolation on subject_envelopes;
create policy subject_envelopes_tenant_isolation on subject_envelopes
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

-- Pairing starts before the agent has an authenticated tenant context. The
-- function exposes only the exact hash match needed to establish that
-- context; all subsequent work must use inTenantTransaction/RLS.
create or replace function lookup_agent_pairing_token(p_token_hash text)
returns table (
  id text,
  tenant_id text,
  environment_id text,
  token_hash text,
  replacement_mode text,
  allow_replacement boolean,
  created_by_actor_id text,
  created_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select
    t.id,
    t.tenant_id,
    t.environment_id,
    t.token_hash,
    t.replacement_mode,
    t.allow_replacement,
    t.created_by_actor_id,
    t.created_at,
    t.expires_at,
    t.consumed_at
  from public.agent_pairing_tokens t
  join public.environments e on e.id = t.environment_id
  join public.projects p
    on p.id = e.project_id
   and p.tenant_id = t.tenant_id
  where t.token_hash = p_token_hash
  limit 1
$function$;

alter function lookup_agent_pairing_token(text) owner to forgetops_bootstrap;

revoke all on function lookup_agent_pairing_token(text) from public;
grant execute on function lookup_agent_pairing_token(text) to forgetops_app;
revoke all on function validate_subject_envelope_scope() from public;

do $$
begin
  execute format('revoke forgetops_bootstrap from %I', current_user);
end;
$$;

grant select, insert, update, delete on subject_envelopes to forgetops_app;
