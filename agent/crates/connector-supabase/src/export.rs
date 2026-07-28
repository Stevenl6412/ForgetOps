use std::collections::HashSet;

use connector_sdk::{
    ConnectorError, ConnectorErrorKind, ExportResult, ExportSelection, ExportSink, SubjectIdentity,
};
use futures_util::{StreamExt, TryStreamExt, pin_mut};
use reqwest::{Method, StatusCode, header};
use tokio_postgres::types::ToSql;

use crate::{
    SupabaseConnector,
    config::stable_user_id,
    discover::{http_error, like_prefix, remote},
};

const MAX_RECORD_BYTES: usize = 1024 * 1024;
const MAX_OBJECT_BYTES: usize = 100 * 1024 * 1024;
const STORAGE_PAGE_SIZE: i64 = 1_000;

impl SupabaseConnector {
    pub(crate) async fn export_subject(
        &self,
        subject: &SubjectIdentity,
        selection: &ExportSelection,
        sink: &mut dyn ExportSink,
    ) -> Result<ExportResult, ConnectorError> {
        let selected: HashSet<&str> = selection.resources.iter().map(String::as_str).collect();
        if selected.is_empty() || selected.len() != selection.resources.len() {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_EXPORT_SELECTION_INVALID",
            ));
        }
        let known: HashSet<String> = self
            .mapping
            .tables
            .iter()
            .map(|table| table.local_reference())
            .chain(
                self.mapping
                    .storage
                    .iter()
                    .map(|storage| storage.local_reference()),
            )
            .chain(
                self.mapping
                    .delete_auth_user
                    .then_some("supabase:auth:user".into()),
            )
            .collect();
        if selected.iter().any(|resource| !known.contains(*resource)) {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_RESOURCE_NOT_MAPPED",
            ));
        }

        let mut exported_count = 0u64;
        for table in &self.mapping.tables {
            if !selected.contains(table.local_reference().as_str()) {
                continue;
            }
            let subject_value = table.subject_value(subject)?;
            let path = if table.schema == "public" {
                format!("supabase/{}/records.json", table.table)
            } else {
                format!("supabase/{}/{}/records.json", table.schema, table.table)
            };
            let mut database = self.database.lock().await;
            let transaction = database
                .build_transaction()
                .read_only(true)
                .start()
                .await
                .map_err(|_| remote("SUPABASE_EXPORT_QUERY_FAILED"))?;
            let sql = format!(
                "select to_jsonb(row_value)::text as record \
                 from (select * from {} where {}::text = $1) row_value",
                table.quoted_name(),
                crate::config::quote_identifier(&table.identity_column)
            );
            let parameters: [&(dyn ToSql + Sync); 1] = [&subject_value];
            let stream = transaction
                .query_raw(&sql, parameters)
                .await
                .map_err(|_| remote("SUPABASE_EXPORT_QUERY_FAILED"))?;
            pin_mut!(stream);
            sink.write(&path, "application/json", b"[").await?;
            let mut first = true;
            while let Some(row) = stream
                .try_next()
                .await
                .map_err(|_| remote("SUPABASE_EXPORT_QUERY_FAILED"))?
            {
                let record: String = row.get("record");
                if record.len() > MAX_RECORD_BYTES {
                    return Err(ConnectorError::remote(
                        ConnectorErrorKind::InvalidResponse,
                        "SUPABASE_EXPORT_RECORD_TOO_LARGE",
                    ));
                }
                if !first {
                    sink.write(&path, "application/json", b",").await?;
                }
                sink.write(&path, "application/json", record.as_bytes())
                    .await?;
                first = false;
                exported_count = exported_count.saturating_add(1);
            }
            sink.write(&path, "application/json", b"]").await?;
            transaction
                .commit()
                .await
                .map_err(|_| remote("SUPABASE_EXPORT_QUERY_FAILED"))?;
        }

        for storage in &self.mapping.storage {
            if !selected.contains(storage.local_reference().as_str()) {
                continue;
            }
            let prefix = storage.subject_prefix(subject)?;
            let mut after = String::new();
            let mut file_index = 0u64;
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
                            &STORAGE_PAGE_SIZE,
                        ],
                    )
                    .await
                    .map_err(|_| remote("SUPABASE_STORAGE_DISCOVERY_FAILED"))?;
                drop(database);
                if rows.is_empty() {
                    break;
                }
                let page_len = rows.len();
                for row in rows {
                    let object_name: String = row.get("name");
                    after.clone_from(&object_name);
                    file_index = file_index.saturating_add(1);
                    self.download_storage_object(&storage.bucket, &object_name, file_index, sink)
                        .await?;
                    exported_count = exported_count.saturating_add(1);
                }
                if page_len < STORAGE_PAGE_SIZE as usize {
                    break;
                }
            }
        }

        if selected.contains("supabase:auth:user") {
            let user_id = stable_user_id(subject)?;
            let url = self.api()?.url(["auth", "v1", "admin", "users", user_id])?;
            let response = self
                .api()?
                .request(Method::GET, url)
                .send()
                .await
                .map_err(|_| remote("SUPABASE_AUTH_EXPORT_FAILED"))?;
            match response.status() {
                status if status.is_success() => {
                    let bytes = bounded_response(response, MAX_RECORD_BYTES).await?;
                    sink.write("supabase/auth/user.json", "application/json", &bytes)
                        .await?;
                    exported_count = exported_count.saturating_add(1);
                }
                StatusCode::NOT_FOUND => {}
                status => return Err(http_error(status, "SUPABASE_AUTH_EXPORT_FAILED")),
            }
        }

        Ok(ExportResult { exported_count })
    }

    async fn download_storage_object(
        &self,
        bucket: &str,
        object_name: &str,
        file_index: u64,
        sink: &mut dyn ExportSink,
    ) -> Result<(), ConnectorError> {
        if object_name.is_empty()
            || object_name.contains('\\')
            || object_name
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(ConnectorError::remote(
                ConnectorErrorKind::InvalidResponse,
                "SUPABASE_STORAGE_OBJECT_PATH_INVALID",
            ));
        }
        let mut segments = vec!["storage", "v1", "object", bucket];
        segments.extend(object_name.split('/'));
        let url = self.api()?.url(segments)?;
        let response = self
            .api()?
            .request(Method::GET, url)
            .send()
            .await
            .map_err(|_| remote("SUPABASE_STORAGE_DOWNLOAD_FAILED"))?;
        if !response.status().is_success() {
            return Err(http_error(
                response.status(),
                "SUPABASE_STORAGE_DOWNLOAD_FAILED",
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_OBJECT_BYTES as u64)
        {
            return Err(ConnectorError::remote(
                ConnectorErrorKind::InvalidResponse,
                "SUPABASE_STORAGE_OBJECT_TOO_LARGE",
            ));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128)
            .unwrap_or("application/octet-stream")
            .to_owned();
        let path = format!("supabase/storage/{bucket}/files/{file_index:06}.bin");
        let mut total = 0usize;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| remote("SUPABASE_STORAGE_DOWNLOAD_FAILED"))?;
            total = total.saturating_add(chunk.len());
            if total > MAX_OBJECT_BYTES {
                return Err(ConnectorError::remote(
                    ConnectorErrorKind::InvalidResponse,
                    "SUPABASE_STORAGE_OBJECT_TOO_LARGE",
                ));
            }
            sink.write(&path, &content_type, &chunk).await?;
        }
        Ok(())
    }
}

async fn bounded_response(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ConnectorError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ConnectorError::remote(
            ConnectorErrorKind::InvalidResponse,
            "SUPABASE_RESPONSE_TOO_LARGE",
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| remote("SUPABASE_RESPONSE_FAILED"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(ConnectorError::remote(
                ConnectorErrorKind::InvalidResponse,
                "SUPABASE_RESPONSE_TOO_LARGE",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
