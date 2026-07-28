//! Declarative Supabase PostgreSQL, Storage, and optional Auth lifecycle connector.

mod discover;
mod erase;
mod export;
mod verify;

pub mod config;

use std::sync::Arc;

use async_trait::async_trait;
use config::ValidatedSupabaseMapping;
use connector_sdk::{
    Connector, ConnectorCapability, ConnectorDescriptor, ConnectorError, DiscoveryRequest,
    DiscoveryResult, ErasePlan, EraseResult, ExecutionContext, ExportResult, ExportSelection,
    ExportSink, HealthStatus, SubjectIdentity, VerificationExpectation, VerificationResult,
};
use reqwest::{Client as HttpClient, Url};
use tokio::sync::Mutex;
use tokio_postgres::Client as PostgresClient;
use zeroize::Zeroizing;

pub struct SupabaseConnector {
    pub(crate) database: Arc<Mutex<PostgresClient>>,
    pub(crate) mapping: ValidatedSupabaseMapping,
    pub(crate) api: Option<SupabaseApi>,
}

pub(crate) struct SupabaseApi {
    base_url: Url,
    service_role_key: Zeroizing<String>,
    client: HttpClient,
}

impl SupabaseConnector {
    pub fn new(
        database: PostgresClient,
        mapping: ValidatedSupabaseMapping,
        api_url: Option<&str>,
        service_role_key: Option<String>,
    ) -> Result<Self, ConnectorError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let api = match (api_url, service_role_key) {
            (Some(url), Some(key)) => Some(SupabaseApi::new(url, key)?),
            (None, None) if mapping.storage.is_empty() && !mapping.delete_auth_user => None,
            _ => {
                return Err(ConnectorError::invalid_config(
                    "SUPABASE_API_CREDENTIALS_REQUIRED",
                ));
            }
        };
        Ok(Self {
            // ponytail: one connection serializes transactions; add a pool only if measured
            // connector throughput exceeds the MVP's request volume.
            database: Arc::new(Mutex::new(database)),
            mapping,
            api,
        })
    }

    fn table_for_resource(&self, resource: &str) -> Result<&config::TableMapping, ConnectorError> {
        self.mapping
            .tables
            .iter()
            .find(|mapping| mapping.local_reference() == resource)
            .ok_or_else(|| ConnectorError::invalid_config("SUPABASE_RESOURCE_NOT_MAPPED"))
    }

    fn storage_for_resource(
        &self,
        resource: &str,
    ) -> Result<&config::StorageMapping, ConnectorError> {
        self.mapping
            .storage
            .iter()
            .find(|mapping| mapping.local_reference() == resource)
            .ok_or_else(|| ConnectorError::invalid_config("SUPABASE_RESOURCE_NOT_MAPPED"))
    }

    fn api(&self) -> Result<&SupabaseApi, ConnectorError> {
        self.api
            .as_ref()
            .ok_or_else(|| ConnectorError::invalid_config("SUPABASE_API_CREDENTIALS_REQUIRED"))
    }
}

impl SupabaseApi {
    fn new(base_url: &str, service_role_key: String) -> Result<Self, ConnectorError> {
        if service_role_key.len() < 32 {
            return Err(ConnectorError::invalid_config(
                "SUPABASE_SERVICE_ROLE_KEY_INVALID",
            ));
        }
        let mut base_url = Url::parse(base_url)
            .map_err(|_| ConnectorError::invalid_config("SUPABASE_API_URL_INVALID"))?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(ConnectorError::invalid_config("SUPABASE_API_URL_INVALID"));
        }
        base_url.set_path("/");
        Ok(Self {
            base_url,
            service_role_key: Zeroizing::new(service_role_key),
            client: HttpClient::new(),
        })
    }

    pub(crate) fn url<'a>(
        &self,
        segments: impl IntoIterator<Item = &'a str>,
    ) -> Result<Url, ConnectorError> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| ConnectorError::invalid_config("SUPABASE_API_URL_INVALID"))?;
            path.clear();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    pub(crate) fn request(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .header("apikey", self.service_role_key.as_str())
            .bearer_auth(self.service_role_key.as_str())
    }
}

#[async_trait]
impl Connector for SupabaseConnector {
    fn descriptor(&self) -> ConnectorDescriptor {
        let mut capabilities = vec![ConnectorCapability::Discover, ConnectorCapability::Verify];
        if !self.mapping.tables.is_empty() || !self.mapping.storage.is_empty() {
            capabilities.extend([ConnectorCapability::Export, ConnectorCapability::Delete]);
        }
        if self
            .mapping
            .tables
            .iter()
            .any(|table| table.action == config::TableAction::Anonymize)
        {
            capabilities.push(ConnectorCapability::Anonymize);
        }
        ConnectorDescriptor {
            name: "supabase".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            capabilities,
        }
    }

    async fn health_check(&self) -> Result<HealthStatus, ConnectorError> {
        self.check_health().await
    }

    async fn discover(
        &self,
        subject: &SubjectIdentity,
        _request: &DiscoveryRequest,
    ) -> Result<DiscoveryResult, ConnectorError> {
        self.discover_subject(subject).await
    }

    async fn export(
        &self,
        subject: &SubjectIdentity,
        selection: &ExportSelection,
        sink: &mut dyn ExportSink,
    ) -> Result<ExportResult, ConnectorError> {
        self.export_subject(subject, selection, sink).await
    }

    async fn erase(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
        context: &ExecutionContext,
    ) -> Result<EraseResult, ConnectorError> {
        self.erase_subject(subject, plan, context).await
    }

    async fn verify(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        self.verify_subject(subject, expectation).await
    }
}
