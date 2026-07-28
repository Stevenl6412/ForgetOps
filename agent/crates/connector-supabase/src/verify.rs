use connector_sdk::{
    ConnectorError, LifecycleOutcome, SubjectIdentity, VerificationExpectation, VerificationResult,
};
use reqwest::{Method, StatusCode};

use crate::{
    SupabaseConnector,
    config::{TableAction, quote_identifier, stable_user_id},
    discover::{http_error, like_prefix, remote},
};

impl SupabaseConnector {
    pub(crate) async fn verify_subject(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        if expectation.resource == "supabase:auth:user" {
            return self.verify_auth_user(subject, expectation).await;
        }
        if expectation.resource.starts_with("supabase:storage:") {
            return self.verify_storage(subject, expectation).await;
        }
        self.verify_table(subject, expectation).await
    }

    async fn verify_table(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        let table = self.table_for_resource(&expectation.resource)?;
        let expected_state = match table.action {
            TableAction::Delete => LifecycleOutcome::Deleted,
            TableAction::Anonymize => LifecycleOutcome::Anonymized,
        };
        if expectation.state != expected_state {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_VERIFICATION_EXPECTATION_MISMATCH",
            ));
        }
        let value = table.subject_value(subject)?;
        let sql = format!(
            "select count(*)::bigint from {} where {}::text = $1",
            table.quoted_name(),
            quote_identifier(&table.identity_column)
        );
        let database = self.database.lock().await;
        let remaining: i64 = database
            .query_one(&sql, &[&value])
            .await
            .map_err(|_| remote("SUPABASE_VERIFY_QUERY_FAILED"))?
            .get(0);
        verification_result(remaining)
    }

    async fn verify_storage(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        if expectation.state != LifecycleOutcome::Deleted {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_VERIFICATION_EXPECTATION_MISMATCH",
            ));
        }
        let storage = self.storage_for_resource(&expectation.resource)?;
        let prefix = storage.subject_prefix(subject)?;
        let database = self.database.lock().await;
        let remaining: i64 = database
            .query_one(
                r#"
                select count(*)::bigint
                from storage.objects
                where bucket_id = $1 and name like $2 escape '\'
                "#,
                &[&storage.bucket, &like_prefix(&prefix)],
            )
            .await
            .map_err(|_| remote("SUPABASE_STORAGE_VERIFY_FAILED"))?
            .get(0);
        verification_result(remaining)
    }

    async fn verify_auth_user(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        if !self.mapping.delete_auth_user || expectation.state != LifecycleOutcome::Deleted {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_VERIFICATION_EXPECTATION_MISMATCH",
            ));
        }
        let user_id = stable_user_id(subject)?;
        let url = self.api()?.url(["auth", "v1", "admin", "users", user_id])?;
        let response = self
            .api()?
            .request(Method::GET, url)
            .send()
            .await
            .map_err(|_| remote("SUPABASE_AUTH_VERIFY_FAILED"))?;
        match response.status() {
            StatusCode::NOT_FOUND => verification_result(0),
            status if status.is_success() => verification_result(1),
            status => Err(http_error(status, "SUPABASE_AUTH_VERIFY_FAILED")),
        }
    }
}

fn verification_result(remaining: i64) -> Result<VerificationResult, ConnectorError> {
    let remaining_count = u64::try_from(remaining).map_err(|_| remote("SUPABASE_COUNT_INVALID"))?;
    Ok(VerificationResult {
        satisfied: remaining_count == 0,
        remaining_count,
        reason: (remaining_count > 0).then(|| "SUPABASE_RESOURCE_REMAINS".into()),
    })
}
