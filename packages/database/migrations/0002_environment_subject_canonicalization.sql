do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'environments'
      and column_name = 'subject_canonicalization_version'
  ) then
    alter table environments
      add column subject_canonicalization_version integer;
  end if;
end;
$$;

update environments
set subject_canonicalization_version = 1
where subject_canonicalization_version is null;

alter table environments
  alter column subject_canonicalization_version set default 1,
  alter column subject_canonicalization_version set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'environments'::regclass
      and conname = 'environments_subject_canonicalization_version_check'
  ) then
    alter table environments
      add constraint environments_subject_canonicalization_version_check
      check (subject_canonicalization_version > 0);
  end if;
end;
$$;
