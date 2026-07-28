//! Auditable lifecycle contract implemented by every local connector.

use std::{error::Error, fmt};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub use agent_core::subject::SubjectIdentity;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorCapability {
    Discover,
    Export,
    Delete,
    Anonymize,
    Retain,
    Verify,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDescriptor {
    pub name: String,
    pub version: String,
    pub capabilities: Vec<ConnectorCapability>,
}

impl ConnectorDescriptor {
    pub fn validate(&self) -> Result<(), ConnectorError> {
        let has = |capability| self.capabilities.contains(&capability);
        if self.name.trim().is_empty()
            || self.version.trim().is_empty()
            || !has(ConnectorCapability::Discover)
            || ((has(ConnectorCapability::Delete) || has(ConnectorCapability::Anonymize))
                && !has(ConnectorCapability::Verify))
        {
            return Err(ConnectorError::invalid_config(
                "CONNECTOR_DESCRIPTOR_INVALID",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub healthy: bool,
    pub checks: Vec<HealthCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub name: String,
    pub healthy: bool,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRequest {
    pub request_id: String,
    pub request_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposedAction {
    Delete,
    Anonymize,
    Export,
    RetainByPolicy,
    Unsupported,
    NeedsReview,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryItem {
    pub local_reference: String,
    pub resource_type: String,
    pub proposed_action: ProposedAction,
    pub estimated_count: u64,
    pub risk: RiskLevel,
    pub dependencies: Vec<String>,
    pub retention_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub items: Vec<DiscoveryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSelection {
    pub resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub exported_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErasePlan {
    pub resource: String,
    pub operation_key: String,
    pub action: ProposedAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub request_id: String,
    pub attempt_id: String,
    pub step_id: String,
    pub idempotency_key: String,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleOutcome {
    Deleted,
    Anonymized,
    RetainedByPolicy,
    Unsupported,
    NeedsReview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EraseResult {
    pub operation_key: String,
    pub outcome: LifecycleOutcome,
    pub affected_count: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerificationExpectation {
    pub resource: String,
    pub state: LifecycleOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub satisfied: bool,
    pub remaining_count: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorErrorKind {
    InvalidConfig,
    PermissionDenied,
    RateLimited,
    Unsupported,
    Remote,
    Uncertain,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorError {
    pub kind: ConnectorErrorKind,
    pub code: String,
}

impl ConnectorError {
    pub fn invalid_config(code: impl Into<String>) -> Self {
        Self {
            kind: ConnectorErrorKind::InvalidConfig,
            code: code.into(),
        }
    }

    pub fn invalid_response(code: impl Into<String>) -> Self {
        Self {
            kind: ConnectorErrorKind::InvalidResponse,
            code: code.into(),
        }
    }

    pub fn remote(kind: ConnectorErrorKind, code: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
        }
    }

    pub fn is_uncertain(&self) -> bool {
        self.kind == ConnectorErrorKind::Uncertain
    }
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for ConnectorError {}

#[async_trait]
pub trait ExportSink: Send {
    async fn write(
        &mut self,
        path: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> Result<(), ConnectorError>;
}

#[async_trait]
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> ConnectorDescriptor;

    async fn health_check(&self) -> Result<HealthStatus, ConnectorError>;

    async fn discover(
        &self,
        subject: &SubjectIdentity,
        request: &DiscoveryRequest,
    ) -> Result<DiscoveryResult, ConnectorError>;

    async fn export(
        &self,
        subject: &SubjectIdentity,
        selection: &ExportSelection,
        sink: &mut dyn ExportSink,
    ) -> Result<ExportResult, ConnectorError>;

    async fn erase(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
        context: &ExecutionContext,
    ) -> Result<EraseResult, ConnectorError>;

    async fn verify(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_capability_requires_verification() {
        let descriptor = ConnectorDescriptor {
            name: "unsafe".into(),
            version: "1".into(),
            capabilities: vec![ConnectorCapability::Discover, ConnectorCapability::Delete],
        };
        assert_eq!(
            descriptor.validate().unwrap_err().code,
            "CONNECTOR_DESCRIPTOR_INVALID"
        );
    }
}
