use connector_sdk::{
    ConnectorError, ConnectorErrorKind, ErasePlan, EraseResult, ExecutionContext, LifecycleOutcome,
    ProposedAction, SubjectIdentity,
};
use reqwest::{Method, StatusCode};

use crate::{
    SupabaseConnector,
    config::{TableAction, quote_identifier, stable_user_id},
    discover::{like_prefix, remote},
};

const STORAGE_DELETE_BATCH: i64 = 1_000;

impl SupabaseConnector {
    pub(crate) async fn erase_subject(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
        context: &ExecutionContext,
    ) -> Result<EraseResult, ConnectorError> {
        if context.dry_run
            || context.idempotency_key.trim().is_empty()
            || plan.operation_key.trim().is_empty()
        {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_EXECUTION_CONTEXT_INVALID",
            ));
        }

        if plan.resource == "supabase:auth:user" {
            return self.erase_auth_user(subject, plan).await;
        }
        if plan.resource.starts_with("supabase:storage:") {
            return self.erase_storage(subject, plan).await;
        }
        self.erase_table(subject, plan).await
    }

    async fn erase_table(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
    ) -> Result<EraseResult, ConnectorError> {
        let table = self.table_for_resource(&plan.resource)?;
        if plan.action != table.proposed_action() {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_PLAN_ACTION_MISMATCH",
            ));
        }
        let value = table.subject_value(subject)?;
        let mut database = self.database.lock().await;
        let transaction = database
            .transaction()
            .await
            .map_err(|_| remote("SUPABASE_ERASE_TRANSACTION_FAILED"))?;
        let (sql, outcome) = match table.action {
            TableAction::Delete => (
                format!(
                    "delete from {} where {}::text = $1",
                    table.quoted_name(),
                    quote_identifier(&table.identity_column)
                ),
                LifecycleOutcome::Deleted,
            ),
            TableAction::Anonymize => (
                format!(
                    "update {} set {} where {}::text = $1",
                    table.quoted_name(),
                    table
                        .fields
                        .iter()
                        .map(|field| format!("{} = null", quote_identifier(field)))
                        .collect::<Vec<_>>()
                        .join(", "),
                    quote_identifier(&table.identity_column)
                ),
                LifecycleOutcome::Anonymized,
            ),
        };
        let affected_count = transaction
            .execute(&sql, &[&value])
            .await
            .map_err(|_| remote("SUPABASE_ERASE_QUERY_FAILED"))?;
        transaction.commit().await.map_err(|_| {
            ConnectorError::remote(
                ConnectorErrorKind::Uncertain,
                "SUPABASE_ERASE_COMMIT_UNCERTAIN",
            )
        })?;
        Ok(EraseResult {
            operation_key: plan.operation_key.clone(),
            outcome,
            affected_count,
            reason: None,
        })
    }

    async fn erase_storage(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
    ) -> Result<EraseResult, ConnectorError> {
        let storage = self.storage_for_resource(&plan.resource)?;
        if plan.action != ProposedAction::Delete {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_PLAN_ACTION_MISMATCH",
            ));
        }
        let prefix = storage.subject_prefix(subject)?;
        let mut after = String::new();
        let mut affected_count = 0u64;
        loop {
            let database = self.database.lock().await;
            let rows = database
                .query(
                    r#"
                    select name
                    from storage.objects
                    where bucket_id = $1
                      and name like $2 escape '\'
                      and name > $3
                    order by name
                    limit $4
                    "#,
                    &[
                        &storage.bucket,
                        &like_prefix(&prefix),
                        &after,
                        &STORAGE_DELETE_BATCH,
                    ],
                )
                .await
                .map_err(|_| remote("SUPABASE_STORAGE_DISCOVERY_FAILED"))?;
            drop(database);
            if rows.is_empty() {
                break;
            }
            let names: Vec<String> = rows.into_iter().map(|row| row.get("name")).collect();
            after.clone_from(names.last().expect("non-empty batch"));
            let url = self
                .api()?
                .url(["storage", "v1", "object", storage.bucket.as_str()])?;
            let response = self
                .api()?
                .request(Method::DELETE, url)
                .json(&serde_json::json!({ "prefixes": names }))
                .send()
                .await
                .map_err(|_| uncertain("SUPABASE_STORAGE_DELETE_UNCERTAIN"))?;
            if !response.status().is_success() && response.status() != StatusCode::NOT_FOUND {
                return Err(destructive_http_error(
                    response.status(),
                    "SUPABASE_STORAGE_DELETE_FAILED",
                ));
            }
            affected_count = affected_count.saturating_add(names.len() as u64);
            if names.len() < STORAGE_DELETE_BATCH as usize {
                break;
            }
        }
        Ok(EraseResult {
            operation_key: plan.operation_key.clone(),
            outcome: LifecycleOutcome::Deleted,
            affected_count,
            reason: None,
        })
    }

    async fn erase_auth_user(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
    ) -> Result<EraseResult, ConnectorError> {
        if !self.mapping.delete_auth_user || plan.action != ProposedAction::Delete {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_RESOURCE_NOT_MAPPED",
            ));
        }
        let user_id = stable_user_id(subject)?;
        let mut url = self.api()?.url(["auth", "v1", "admin", "users", user_id])?;
        url.query_pairs_mut()
            .append_pair("should_soft_delete", "false");
        let response = self
            .api()?
            .request(Method::DELETE, url)
            .send()
            .await
            .map_err(|_| uncertain("SUPABASE_AUTH_DELETE_UNCERTAIN"))?;
        let affected_count = match response.status() {
            status if status.is_success() => 1,
            StatusCode::NOT_FOUND => 0,
            status => {
                return Err(destructive_http_error(
                    status,
                    "SUPABASE_AUTH_DELETE_FAILED",
                ));
            }
        };
        Ok(EraseResult {
            operation_key: plan.operation_key.clone(),
            outcome: LifecycleOutcome::Deleted,
            affected_count,
            reason: None,
        })
    }
}

fn uncertain(code: &'static str) -> ConnectorError {
    ConnectorError::remote(ConnectorErrorKind::Uncertain, code)
}

fn destructive_http_error(status: StatusCode, code: &'static str) -> ConnectorError {
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ConnectorErrorKind::PermissionDenied,
        StatusCode::TOO_MANY_REQUESTS => ConnectorErrorKind::RateLimited,
        status if status.is_server_error() => ConnectorErrorKind::Uncertain,
        _ => ConnectorErrorKind::InvalidResponse,
    };
    ConnectorError::remote(kind, code)
}
