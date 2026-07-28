use std::collections::BTreeMap;

use async_trait::async_trait;
use connector_sdk::{
    Connector, ConnectorError, DiscoveryRequest, ErasePlan, ExecutionContext, ExportSelection,
    ExportSink, LifecycleOutcome, ProposedAction, SubjectIdentity, VerificationExpectation,
};
use connector_supabase::{SupabaseConnector, config::SupabaseMapping};
use testcontainers::{
    GenericImage, ImageExt,
    core::{IntoContainerPort, WaitFor},
    runners::AsyncRunner,
};
use tokio_postgres::NoTls;

#[tokio::test]
async fn deletes_target_and_preserves_unrelated_rows() {
    let container = GenericImage::new("postgres", "17-alpine")
        .with_exposed_port(5432.tcp())
        .with_wait_for(WaitFor::message_on_stderr(
            "database system is ready to accept connections",
        ))
        .with_env_var("POSTGRES_DB", "forgetops")
        .with_env_var("POSTGRES_USER", "postgres")
        .with_env_var("POSTGRES_PASSWORD", "postgres")
        .start()
        .await
        .unwrap();
    let port = container.get_host_port_ipv4(5432.tcp()).await.unwrap();
    let admin_url = format!("postgres://postgres:postgres@127.0.0.1:{port}/forgetops");
    let (admin, admin_connection) = tokio_postgres::connect(&admin_url, NoTls).await.unwrap();
    tokio::spawn(async move { admin_connection.await.unwrap() });
    admin
        .batch_execute(
            r#"
            create table profiles (
              user_id text primary key,
              email text not null
            );
            create table documents (
              id text primary key,
              owner_id text not null,
              body text not null
            );
            create table unrelated (
              id text primary key,
              body text not null
            );
            insert into profiles values
              ('user_target', 'target@example.com'),
              ('user_other', 'other@example.com');
            insert into documents values
              ('doc_target', 'user_target', 'target body'),
              ('doc_other', 'user_other', 'other body');
            insert into unrelated values ('unrelated_1', 'must remain');

            create role forgetops_connector login password 'connector';
            revoke all on all tables in schema public from public;
            grant usage on schema public to forgetops_connector;
            grant select, delete on profiles, documents to forgetops_connector;
            "#,
        )
        .await
        .unwrap();

    let restricted_url =
        format!("postgres://forgetops_connector:connector@127.0.0.1:{port}/forgetops");
    let (restricted, restricted_connection) = tokio_postgres::connect(&restricted_url, NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { restricted_connection.await.unwrap() });
    let mapping = SupabaseMapping::from_yaml(
        r#"
tables:
  profiles:
    identity_column: user_id
    delete: true
  documents:
    identity_column: owner_id
    delete: true
"#,
    )
    .unwrap()
    .validate()
    .unwrap();
    let connector = SupabaseConnector::new(restricted, mapping, None, None).unwrap();
    assert!(connector.health_check().await.unwrap().healthy);
    admin
        .batch_execute("grant select on unrelated to forgetops_connector")
        .await
        .unwrap();
    let leaked_table_health = connector.health_check().await.unwrap();
    assert!(!leaked_table_health.healthy);
    assert!(
        leaked_table_health
            .checks
            .iter()
            .any(|check| { check.code.as_deref() == Some("SUPABASE_UNMAPPED_TABLE_ACCESSIBLE") })
    );
    admin
        .batch_execute(
            r#"
            revoke select on unrelated from forgetops_connector;
            create function public.unapproved_connector_function()
              returns integer language sql as 'select 1';
            revoke execute on function public.unapproved_connector_function() from public;
            grant execute on function public.unapproved_connector_function()
              to forgetops_connector;
            "#,
        )
        .await
        .unwrap();
    let leaked_function_health = connector.health_check().await.unwrap();
    assert!(!leaked_function_health.healthy);
    assert!(
        leaked_function_health.checks.iter().any(|check| {
            check.code.as_deref() == Some("SUPABASE_UNAPPROVED_FUNCTION_EXECUTABLE")
        })
    );
    admin
        .batch_execute(
            r#"
            revoke execute on function public.unapproved_connector_function()
              from forgetops_connector;
            drop function public.unapproved_connector_function();
            "#,
        )
        .await
        .unwrap();
    assert!(connector.health_check().await.unwrap().healthy);

    let subject = SubjectIdentity {
        application_user_id: Some("user_target".into()),
        email: Some("target@example.com".into()),
    };
    let discovery = connector
        .discover(
            &subject,
            &DiscoveryRequest {
                request_id: "req_supabase".into(),
                request_type: "delete".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        discovery
            .items
            .iter()
            .map(|item| item.estimated_count)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );

    let selection = ExportSelection {
        resources: discovery
            .items
            .iter()
            .map(|item| item.local_reference.clone())
            .collect(),
    };
    let mut sink = MemorySink::default();
    let export = connector
        .export(&subject, &selection, &mut sink)
        .await
        .unwrap();
    assert_eq!(export.exported_count, 2);
    assert!(sink.files.keys().all(|path| !path.contains("user_target")));

    for item in &discovery.items {
        let plan = ErasePlan {
            resource: item.local_reference.clone(),
            operation_key: format!("op:{}", item.local_reference),
            action: ProposedAction::Delete,
        };
        let context = ExecutionContext {
            request_id: "req_supabase".into(),
            attempt_id: "attempt_1".into(),
            step_id: item.local_reference.clone(),
            idempotency_key: format!("req_supabase:{}", item.local_reference),
            dry_run: false,
        };
        connector
            .erase(
                &subject,
                &plan,
                &ExecutionContext {
                    dry_run: true,
                    ..context.clone()
                },
            )
            .await
            .unwrap_err();
        connector.erase(&subject, &plan, &context).await.unwrap();
        let verification = connector
            .verify(
                &subject,
                &VerificationExpectation {
                    resource: item.local_reference.clone(),
                    state: LifecycleOutcome::Deleted,
                },
            )
            .await
            .unwrap();
        assert!(verification.satisfied);
        let replay = connector.erase(&subject, &plan, &context).await.unwrap();
        assert_eq!(replay.affected_count, 0);
    }

    let target_profiles: i64 = admin
        .query_one(
            "select count(*)::bigint from profiles where user_id = 'user_target'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let unrelated_users: i64 = admin
        .query_one(
            "select count(*)::bigint from profiles where user_id = 'user_other'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let unrelated_documents: i64 = admin
        .query_one(
            "select count(*)::bigint from documents where owner_id = 'user_other'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let unrelated_rows: i64 = admin
        .query_one("select count(*)::bigint from unrelated", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(target_profiles, 0);
    assert_eq!(unrelated_users, 1);
    assert_eq!(unrelated_documents, 1);
    assert_eq!(unrelated_rows, 1);
}

#[derive(Default)]
struct MemorySink {
    files: BTreeMap<String, Vec<u8>>,
}

#[async_trait]
impl ExportSink for MemorySink {
    async fn write(
        &mut self,
        path: &str,
        _content_type: &str,
        bytes: &[u8],
    ) -> Result<(), ConnectorError> {
        self.files.entry(path.into()).or_default().extend(bytes);
        Ok(())
    }
}
