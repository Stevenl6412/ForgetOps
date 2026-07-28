use std::collections::{HashMap, HashSet};

use connector_sdk::{
    ConnectorError, ConnectorErrorKind, DiscoveryItem, DiscoveryResult, HealthCheck, HealthStatus,
    ProposedAction, RiskLevel, SubjectIdentity,
};
use reqwest::{Method, StatusCode};

use crate::{SupabaseConnector, config::stable_user_id};

impl SupabaseConnector {
    pub(crate) async fn check_health(&self) -> Result<HealthStatus, ConnectorError> {
        let mut checks = Vec::new();
        let mut database = self.database.lock().await;
        let transaction = database
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
        let mut allowed_tables: HashSet<String> = self
            .mapping
            .tables
            .iter()
            .map(|table| table.qualified_name())
            .collect();
        if !self.mapping.storage.is_empty() {
            allowed_tables.insert("storage.objects".into());
        }

        for table in &self.mapping.tables {
            let columns = transaction
                .query(
                    r#"
                    select column_name, is_nullable = 'YES' as nullable
                    from information_schema.columns
                    where table_schema = $1 and table_name = $2
                    "#,
                    &[&table.schema, &table.table],
                )
                .await
                .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
            let columns: HashMap<String, bool> = columns
                .into_iter()
                .map(|row| (row.get("column_name"), row.get("nullable")))
                .collect();
            let schema_valid = columns.contains_key(&table.identity_column)
                && table
                    .fields
                    .iter()
                    .all(|field| columns.get(field) == Some(&true));
            let privileges = transaction
                .query_one(
                    r#"
                    select
                      has_table_privilege(current_user, $1, 'SELECT') as can_select,
                      has_table_privilege(current_user, $1, 'DELETE') as can_delete,
                      has_table_privilege(current_user, $1, 'UPDATE') as can_update
                    "#,
                    &[&table.qualified_name()],
                )
                .await
                .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
            let can_select: bool = privileges.get("can_select");
            let action_allowed = match table.action {
                crate::config::TableAction::Delete => privileges.get("can_delete"),
                crate::config::TableAction::Anonymize => privileges.get("can_update"),
            };
            checks.push(HealthCheck {
                name: format!("table:{}", table.qualified_name()),
                healthy: schema_valid && can_select && action_allowed,
                code: (!(schema_valid && can_select && action_allowed))
                    .then(|| "SUPABASE_TABLE_SCOPE_INVALID".into()),
            });
        }

        if !self.mapping.storage.is_empty() {
            let storage_readable: bool = transaction
                .query_one(
                    "select has_table_privilege(current_user, 'storage.objects', 'SELECT')",
                    &[],
                )
                .await
                .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?
                .get(0);
            checks.push(HealthCheck {
                name: "storage:metadata-read".into(),
                healthy: storage_readable,
                code: (!storage_readable).then(|| "SUPABASE_STORAGE_SCOPE_INVALID".into()),
            });
        }

        let table_privileges = transaction
            .query(
                r#"
                select n.nspname || '.' || c.relname as qualified_name,
                       (
                         has_table_privilege(current_user, c.oid, 'SELECT')
                         or has_table_privilege(current_user, c.oid, 'INSERT')
                         or has_table_privilege(current_user, c.oid, 'UPDATE')
                         or has_table_privilege(current_user, c.oid, 'DELETE')
                         or has_table_privilege(current_user, c.oid, 'TRUNCATE')
                         or has_table_privilege(current_user, c.oid, 'REFERENCES')
                         or has_table_privilege(current_user, c.oid, 'TRIGGER')
                       ) as accessible
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('r', 'p', 'v', 'm')
                  and n.nspname not in ('pg_catalog', 'information_schema')
                  and n.nspname not like 'pg_toast%'
                "#,
                &[],
            )
            .await
            .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
        let leaked_table = table_privileges.into_iter().any(|row| {
            let qualified_name: String = row.get("qualified_name");
            let accessible: bool = row.get("accessible");
            accessible && !allowed_tables.contains(&qualified_name)
        });
        checks.push(HealthCheck {
            name: "database:unmapped-tables".into(),
            healthy: !leaked_table,
            code: leaked_table.then(|| "SUPABASE_UNMAPPED_TABLE_ACCESSIBLE".into()),
        });

        let approved_functions: HashSet<&str> = self
            .mapping
            .approved_functions
            .iter()
            .map(String::as_str)
            .collect();
        let function_privileges = transaction
            .query(
                r#"
                select n.nspname || '.' || p.proname as qualified_name,
                       has_function_privilege(current_user, p.oid, 'EXECUTE') as executable
                from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname not in ('pg_catalog', 'information_schema')
                  and n.nspname not like 'pg_toast%'
                "#,
                &[],
            )
            .await
            .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
        let leaked_function = function_privileges.into_iter().any(|row| {
            let qualified_name: String = row.get("qualified_name");
            let executable: bool = row.get("executable");
            executable && !approved_functions.contains(qualified_name.as_str())
        });
        checks.push(HealthCheck {
            name: "database:unapproved-functions".into(),
            healthy: !leaked_function,
            code: leaked_function.then(|| "SUPABASE_UNAPPROVED_FUNCTION_EXECUTABLE".into()),
        });
        transaction
            .commit()
            .await
            .map_err(|_| remote("SUPABASE_HEALTH_QUERY_FAILED"))?;
        drop(database);

        for storage in &self.mapping.storage {
            let url = self
                .api()?
                .url(["storage", "v1", "bucket", storage.bucket.as_str()])?;
            let healthy = self
                .api()?
                .request(Method::GET, url)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success());
            checks.push(HealthCheck {
                name: format!("storage:{}", storage.bucket),
                healthy,
                code: (!healthy).then(|| "SUPABASE_STORAGE_BUCKET_UNAVAILABLE".into()),
            });
        }

        Ok(HealthStatus {
            healthy: checks.iter().all(|check| check.healthy),
            checks,
        })
    }

    pub(crate) async fn discover_subject(
        &self,
        subject: &SubjectIdentity,
    ) -> Result<DiscoveryResult, ConnectorError> {
        let mut items = Vec::new();
        let mut database = self.database.lock().await;
        let transaction = database
            .build_transaction()
            .read_only(true)
            .start()
            .await
            .map_err(|_| remote("SUPABASE_DISCOVERY_FAILED"))?;

        for table in &self.mapping.tables {
            let value = table.subject_value(subject)?;
            let sql = format!(
                "select count(*)::bigint from {} where {}::text = $1",
                table.quoted_name(),
                crate::config::quote_identifier(&table.identity_column)
            );
            let estimated_count: i64 = transaction
                .query_one(&sql, &[&value])
                .await
                .map_err(|_| remote("SUPABASE_DISCOVERY_FAILED"))?
                .get(0);
            let cascade: bool = transaction
                .query_one(
                    r#"
                    select exists (
                      select 1
                      from pg_constraint
                      where confrelid = to_regclass($1)
                        and contype = 'f'
                        and confdeltype = 'c'
                    )
                    "#,
                    &[&table.qualified_name()],
                )
                .await
                .map_err(|_| remote("SUPABASE_DISCOVERY_FAILED"))?
                .get(0);
            items.push(DiscoveryItem {
                local_reference: table.local_reference(),
                resource_type: "supabase_table".into(),
                proposed_action: table.proposed_action(),
                estimated_count: count(estimated_count)?,
                risk: if cascade {
                    RiskLevel::High
                } else {
                    RiskLevel::Medium
                },
                dependencies: Vec::new(),
                retention_reason: None,
            });
        }

        for storage in &self.mapping.storage {
            let prefix = storage.subject_prefix(subject)?;
            let estimated_count: i64 = transaction
                .query_one(
                    r#"
                    select count(*)::bigint
                    from storage.objects
                    where bucket_id = $1 and name like $2 escape '\'
                    "#,
                    &[&storage.bucket, &like_prefix(&prefix)],
                )
                .await
                .map_err(|_| remote("SUPABASE_DISCOVERY_FAILED"))?
                .get(0);
            items.push(DiscoveryItem {
                local_reference: storage.local_reference(),
                resource_type: "supabase_storage".into(),
                proposed_action: ProposedAction::Delete,
                estimated_count: count(estimated_count)?,
                risk: RiskLevel::Medium,
                dependencies: Vec::new(),
                retention_reason: None,
            });
        }
        transaction
            .commit()
            .await
            .map_err(|_| remote("SUPABASE_DISCOVERY_FAILED"))?;
        drop(database);

        if self.mapping.delete_auth_user {
            let user_id = stable_user_id(subject)?;
            let url = self.api()?.url(["auth", "v1", "admin", "users", user_id])?;
            let response = self
                .api()?
                .request(Method::GET, url)
                .send()
                .await
                .map_err(|_| remote("SUPABASE_AUTH_DISCOVERY_FAILED"))?;
            let estimated_count = match response.status() {
                status if status.is_success() => 1,
                StatusCode::NOT_FOUND => 0,
                status => return Err(http_error(status, "SUPABASE_AUTH_DISCOVERY_FAILED")),
            };
            items.push(DiscoveryItem {
                local_reference: "supabase:auth:user".into(),
                resource_type: "supabase_auth_user".into(),
                proposed_action: ProposedAction::Delete,
                estimated_count,
                risk: RiskLevel::High,
                dependencies: items
                    .iter()
                    .map(|item| item.local_reference.clone())
                    .collect(),
                retention_reason: None,
            });
        }
        Ok(DiscoveryResult { items })
    }
}

pub(crate) fn like_prefix(prefix: &str) -> String {
    let mut escaped = String::with_capacity(prefix.len() + 1);
    for character in prefix.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('%');
    escaped
}

pub(crate) fn remote(code: &'static str) -> ConnectorError {
    ConnectorError::remote(ConnectorErrorKind::Remote, code)
}

pub(crate) fn http_error(status: StatusCode, code: &'static str) -> ConnectorError {
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ConnectorErrorKind::PermissionDenied,
        StatusCode::TOO_MANY_REQUESTS => ConnectorErrorKind::RateLimited,
        status if status.is_server_error() => ConnectorErrorKind::Remote,
        _ => ConnectorErrorKind::InvalidResponse,
    };
    ConnectorError::remote(kind, code)
}

fn count(value: i64) -> Result<u64, ConnectorError> {
    u64::try_from(value).map_err(|_| remote("SUPABASE_COUNT_INVALID"))
}
