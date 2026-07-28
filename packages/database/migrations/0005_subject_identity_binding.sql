-- Task 8: encrypted subject-envelope binding and explicit, typed aliases.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'subject_envelopes'::regclass
      and conname = 'subject_envelopes_ciphertext_check'
  ) then
    alter table subject_envelopes
      add constraint subject_envelopes_ciphertext_check
      check (length(ciphertext) > 0);
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'subject_envelopes'::regclass
      and conname = 'subject_envelopes_encryption_key_id_check'
  ) then
    alter table subject_envelopes
      add constraint subject_envelopes_encryption_key_id_check
      check (length(encryption_key_id) between 16 and 128);
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'subject_envelopes'::regclass
      and conname = 'subject_envelopes_expiry_check'
  ) then
    alter table subject_envelopes
      add constraint subject_envelopes_expiry_check
      check (expires_at > created_at);
  end if;
end;
$$;

create table if not exists subject_identity_aliases (
  request_id text not null references privacy_requests(id) on delete cascade,
  tenant_id text not null references tenants(id),
  environment_id text not null references environments(id),
  identifier_kind text not null check (identifier_kind = 'email'),
  subject_hash text not null check (
    subject_hash ~ '^hmac-sha256:[0-9a-f]{64}$'
  ),
  subject_hash_key_version integer not null check (subject_hash_key_version > 0),
  canonicalization_version integer not null check (canonicalization_version > 0),
  created_at timestamptz not null default now(),
  primary key (request_id, identifier_kind, subject_hash)
);

create index if not exists subject_identity_aliases_environment_hash_idx
  on subject_identity_aliases(environment_id, subject_hash);

create or replace function validate_subject_identity_alias_scope()
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
    raise exception 'subject identity alias scope does not match request'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

do $$
begin
  grant forgetops_bootstrap to current_user;
end;
$$;

grant select (id, tenant_id, environment_id)
  on privacy_requests to forgetops_bootstrap;
alter function validate_subject_identity_alias_scope() owner to forgetops_bootstrap;
revoke all on function validate_subject_identity_alias_scope() from public;

drop trigger if exists subject_identity_alias_scope_validation
  on subject_identity_aliases;
create trigger subject_identity_alias_scope_validation
before insert or update on subject_identity_aliases
for each row execute function validate_subject_identity_alias_scope();

alter table subject_identity_aliases enable row level security;
alter table subject_identity_aliases force row level security;

drop policy if exists subject_identity_aliases_tenant_isolation
  on subject_identity_aliases;
create policy subject_identity_aliases_tenant_isolation
  on subject_identity_aliases
  for all
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update, delete
  on subject_identity_aliases to forgetops_app;

do $$
begin
  revoke forgetops_bootstrap from current_user;
end;
$$;
