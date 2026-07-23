use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAuthorizationClaims {
    pub issuer: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_id: String,
    pub plan_id: String,
    pub plan_version: u32,
    pub plan_fingerprint: String,
    pub issued_at: String,
    pub expires_at: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub protocol_version: String,
    pub message_type: String,
    pub message_id: String,
    pub environment_id: String,
    pub agent_id: String,
    pub sequence: String,
    pub sent_at: String,
    pub payload: Value,
    pub signature: String,
}
