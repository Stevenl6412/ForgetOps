use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod canonical_json;
pub mod signing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyRequestStatus {
    Created,
    IdentityVerificationPending,
    IdentityVerified,
    Planning,
    AwaitingApproval,
    ExecutionAuthorized,
    Executing,
    NeedsReview,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAuthorizationClaims {
    pub r#type: String,
    pub version: u8,
    pub key_id: String,
    pub issuer: String,
    pub audience: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_id: String,
    pub attempt_id: String,
    pub authorization_kind: String,
    pub plan_id: String,
    pub plan_version: u32,
    pub plan_fingerprint: String,
    pub policy_version: u32,
    pub connector_configuration_fingerprint: String,
    pub allowed_step_ids: Vec<String>,
    pub approval_evidence_hash: String,
    pub issued_at: String,
    pub not_before: String,
    pub expires_at: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub r#type: String,
    pub protocol_version: String,
    pub message_type: String,
    pub message_id: String,
    pub key_id: String,
    pub environment_id: String,
    pub agent_id: String,
    pub direction: String,
    pub sequence: String,
    pub sent_at: String,
    pub payload: Value,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLeaseClaims {
    pub r#type: String,
    pub version: u8,
    pub key_id: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_id: String,
    pub attempt_id: String,
    pub allowed_step_ids: Vec<String>,
    pub issued_at: String,
    pub expires_at: String,
    pub lease_id: String,
}
