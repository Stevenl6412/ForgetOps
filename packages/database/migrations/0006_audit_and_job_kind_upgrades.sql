-- Additive upgrades for databases created before the expanded MVP job kinds
-- and audit hash uniqueness were included in the baseline migration.

alter table agent_jobs
  drop constraint if exists agent_jobs_kind_check;

alter table agent_jobs
  add constraint agent_jobs_kind_check
  check (
    kind in (
      'bind_subject',
      'plan',
      'execute',
      'lease_execution',
      'wrap_export_key',
      'cancel',
      'health_check'
    )
  );

create unique index if not exists audit_events_environment_hash_uq
  on audit_events(environment_id, event_hash);
